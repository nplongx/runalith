# Recovery verifier provenance successor v174 — 2026-11-01

`recovery-verifier-v174.json` advances the active source-provenance ledger after provider-ledger-only persistence moved into `ExecutionPersistenceStore` and AGG V2 source inventories advanced. It does not change the frozen Goal/Idea graph oracle, tasks, evidence requirements, accepted paths, or scoring rubric.

- Active fixture: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v174.json`
- Immediate predecessor: v173, SHA-256 `ed77482df80c7403546be7724547f76160ef5cf771f84409ad8d5139e75cb514` (immutable)
- Schema version: 123; fixture ID: `recovery-verifier-investigation-v123`
- Provenance revision: 158; pins: 246 (15 existing source pins refreshed, 15 new evidence pins)
- Migration: `recovery-verifier-v173` to `recovery-verifier-v174`; exact predecessor digest embedded in `migration.priorFixtureSha256`.

## Execution persistence boundary

`ExecutionPersistenceStore` v1 now owns provider-ledger-only dispatch intent reservation/outcome, provider-run persistence/binding, reconciled-run binding and no-send claim release. `WorkflowStatePort` v2 retains compatibility wrappers. Cross-domain send/result/lease fences remain in WorkflowStatePort on the exact shared SQLite connection. Attempts, results, task leases, execution batches, task projections, shared event journal and M12 start-intent/runtime remain Workflow-owned or mixed transaction groups; no independent Execution database is claimed.

## AGG V2 successors

| Artifact | SHA-256 | Evidence |
|---|---|---|
| RecordEvent inventory v0.5.17 | `324079147e592e72abcf0576cf8ab3d8dc4ce2ea434d89939451714cd9de6108` | 108 source files, 114 semantic tuples, 97 literal / 17 computed; v0.5.16 immutable |
| RecordEvent register v0.5.17 | `a800b4489e5f8431b9b9eeaf69a7f3c8e21219bab5b7caf9eb52b43545436201` | Exact refreshed file hashes; all computed producer resolution objects and direct SQL event writers preserved |
| SQL inventory v15 | `d1e6f1ff59046a77bff93b611837245617f3f4f90cba413bb05cd4f5d5cb3cb3` | 181 source files, 1,309 direct SQL callsites; an additional 25 provider-ledger SQL callsites moved, cumulative 42 in ExecutionPersistenceStore |
| Event query register v0.5.14 | `494155e5b12c5efa4f3ccbca15ba095c833d10626877bb7e480208999b4183df` | 134 event-query shapes unchanged; nine source-line bindings refreshed; seven unresolved queries remain unresolved |

Historical v172 and v173 fixture bytes, v0.5.16 RecordEvent artifacts, v0.5.13 event-query register and SQL inventory v14 remain unchanged and hash-pinned. New evidence paths have no fabricated predecessor digest. These are local source-integrity inventories, not production authorization, a normative event registry, complete writer proof or independent release provenance.

## Acceptance

- `node benchmarks/adaptive-goal-graph/run-benchmark.mjs`: PASS; writes only the requested local report.
- Final benchmark report `/tmp/recovery-verifier-v174-output-20261101-final5.json`, SHA-256 `d32ce27555223ef72ab81a74aa332bc65c3e6282ff702b6534e4a0d9129d411f`.
- `node --test tests/test-adaptive-goal-benchmark.mjs`: 15/15 PASS.
- `node --test tests/test-agg-v2-event-callers.mjs`: 9/9 PASS.
- `node --test tests/test-agg-v2-sql-mutation-audit.mjs`: 13/13 PASS.
- Producer-to-dispatch, reviewer/approval, trust and Phase 2 custody focused suite: 52/52 PASS across the six E2E/trust test files; test-local trust does not provision production roots.

The refreshed 2026-11-01 read-only reconciliation considered 87 jobs: 61 require owner reconciliation, 7 await dispatch and 19 await proposal/approval. It observed 62 running tasks without active lease rows or execution metadata; zero terminal dispositions were verified. The live Goal/Idea database has 24 nodes, 25 revisions, 24 memberships, 16 edges, zero persisted verifications and 427 planner evidence rows; 314 are unclassified, 48 are not content-addressed, one has invalid artifact lineage and one has a source-hash mismatch. All five effective host trust configuration values are empty; trust-ledger tables contain zero rows. The current workflow DB has no provider-run, dispatch-intent or M12 runtime tables. The machine-readable observation is `artifacts/adaptive-goal-graph/subsystem-extraction-live-observation-20261101-v2.json`; the per-record diagnostic is `/tmp/subsystem-extraction-live-reconciliation-20261101-v2.json` (SHA-256 `e7ad62b325f0cf3e57e83ed6af7dee4de9826e775cca25bad9d1d042640cffb7`).

`subsystem-extraction-readiness-20261101-v5.json` SHA-256 `dfe9489b286f63a5426d6467b41ee24231dabc7dfd522e5328912d9cba2d0c8d` is the expanded unified local acceptance report. All 14 checks passed: Goal/Idea producer-to-dispatch negative tests, reviewer/approval, trust/checkpoint, persistence concurrency/recovery, historical archive migration, AGG V2 provenance, package-consumer, reproducibility, MCPB alignment and documentation. The report remains `BLOCKED` because Workflow, Execution and Agent Session are not standalone; local PASS does not establish independent stateful extraction, external release provenance, production trust, checkpoint continuity or drain authority. v174 does not convert isolated E2E tests into production snapshot, reviewer, trust-root or owner approval evidence. RC.23 authority and lifecycle gates remain open; rollout stays BLOCKED. See `docs/subsystems/milestone-2-authority-remediation.md` for exact owner decisions and verification steps.

The read-only rollout preflight against the exact preserved RC.72 v7 archive and RC.71 v153 rollback archive is `/tmp/subsystem-extraction-rollout-preflight-20261101-v2.json`, SHA-256 `e40d2688eb8a507da09b528b3509f0dc3b2b1587589c64295e3d8909beeb727f`, exit code 3. It reports `BLOCKED`, `canActivateNow=false`, `readOnly=true`, `liveMutationPerformed=false`, with candidate source alignment plus all six RC.23 authority/lifecycle blockers. Candidate ZIP integrity passes; source/runtime/archive identity does not. Rollback was not evaluated after candidate alignment failure.
