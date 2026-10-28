# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.28

**Production decision: `BLOCKED`.** RC.28 adds CodeGraph-derived AGG regression coverage to the required npm acceptance chain. It carries forward the RC.27 runtime implementation unchanged and does not add evidence, trust roots, reviewer approvals, release receipts or workflow-state mutations.

## Why CodeGraph changed the acceptance set

The repository was explored with the installed CodeGraph CLI 1.6.0. Its index reported 480 files, 17,719 nodes and 78,502 edges and was up to date. The call graph for `normalizeEvidenceManifest` points to the persisted-attestation readback, current-verification, attestation-request and attestation write paths. The implementation deliberately makes an empty manifest diagnostic-only and ineligible for attestation. It requires durable `artifact://` producer evidence or pinned, content-addressed source bytes and keeps source-byte integrity separate from claim truth and independence.

The focused `codegraph affected` query identified 23 AGG-related tests. Eight tests not in the main `npm test` path were added to `test:agg-codegraph-regression`; the two planner telemetry tests from the affected set were already reached by `npm run test:agg-telemetry`. CodeGraph is a static test-selection aid, not a production trust authority or a substitute for executing those tests. Its default `affected` output can be empty without an explicit test glob, so the accepted query uses `-f 'tests/test-adaptive-goal-*'`.

## Acceptance invariants

1. A correct graph structure or SHA-256 does not establish claim truth or an independently authenticated snapshot.
2. `KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY` remains open until real producer-bound evidence references resolve against exact artifact bytes and producer/result/attempt/completion lineage.
3. Goal/Idea verification and action-intent reviewer identity require two effective, independently administered trust domains with pinned config versions/fingerprints, distinct provider IDs and disjoint public roots.
4. Plan Graph steps require typed supporting evidence and an authenticated current-snapshot binding; Execution Graph proposals remain review-only until immutable plan pinning and a valid trusted reviewer approval pass the runtime checks.
5. Source-hash mismatches are immutable historical findings; never rewrite old expected digests to clear them.
6. Missing lease/PID evidence is uncertainty, not worker-death proof. All running/executing work remains owner-reconciled and non-authorizing until its true outcome is established.
7. RC.28's test expansion cannot close any of the six RC.23 release gates.

## Current graph and workflow observations

The latest current-scope snapshot and read-only reconciliation captured by the RC.27 dossier show 7 Goal/Idea nodes, 7 edges and 7 memberships; zero evidence references; 4 source-hash mismatch records; 3 Plan Graph proposals, 22 steps and 22 steps missing supporting evidence; 3 proposals without authenticated snapshot binding; and 0 persisted Execution Graph proposals. The current selected workflow inventory shows 60 executing jobs and 61 running tasks without active leases. The snapshot hash is `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`; the evidence manifest hash is the canonical empty-manifest hash `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.

Both trust JSON configs are blank in the effective RC.26 host runtime. Those observations must be refreshed through the live runtime and read-only reconciliation; this document is not a fresh signature or a permanent live-state claim.

## RC.28 validation additions

`npm run test:agg-codegraph-regression` runs the eight previously omitted tests:

- `tests/test-adaptive-goal-benchmark-integrity.mjs`
- `tests/test-adaptive-goal-compatibility.js`
- `tests/test-adaptive-goal-knowledge-capture-mcp.mjs`
- `tests/test-adaptive-goal-knowledge-capture.mjs`
- `tests/test-adaptive-goal-knowledge-store.js`
- `tests/test-adaptive-goal-local-llm-failure.mjs`
- `tests/test-adaptive-goal-sandbox-executor.mjs`
- `tests/test-adaptive-goal-source-evidence.js`

This script is now invoked by `npm test`. Preserve the immutable benchmark history: v68 (RC.26) and v69 (RC.27) are unchanged; v70 is the RC.28 successor with new current-source pins. After the candidate build, full `npm test`, package reproducibility, archive-extracted MCP tests, source/archive alignment, exact hash checks, local and external documentation checks, `git diff --check` and a fresh read-only rollout preflight must all be recorded with exact exit codes and artifact paths.

## External closure requirements

The same six gates remain owner-dependent: signed canonical 71-path contract and controlled-builder receipt; independent release provenance/verification/approval; authority-issued versioned verifier/reviewer trust configs; an independently protected external checkpoint anchor; and record-level workflow/task drain proven by workflow owners and provider/runtime operators. No source or test change in RC.28 can manufacture these authority artifacts. The rollout remains `BLOCKED` until each gate is independently verified for the exact candidate and rollback.
