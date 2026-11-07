# Recovery verifier provenance successor v173 — 2026-11-01

## Purpose

`recovery-verifier-v173.json` advances the benchmark's active source-provenance ledger without changing the frozen benchmark scenario, graph, evidence requirements, ground-truth paths, scoring rubric, or historical fixtures.

- Active fixture: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v173.json`
- Immediate predecessor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v172.json`
- v172 SHA-256: `1c2b9a0c4a92df4f095161b405009da024b8b006c9663212c7340e081ebe0204`
- v173 SHA-256: recorded after final artifact construction
- Migration: `recovery-verifier-v172` to `recovery-verifier-v173`
- Authority: local source integrity only; not external provenance, approval, release, or production trust evidence

## Source evolution reviewed

| Source | Immutable v172 pin | Current v173 pin | Evidence |
|---|---|---|---|
| `tests/test-agg-v2-event-callers.mjs` | `ebd037409727f90fe313d985282e3286aeda6961e9daef9a351c4d24a434148c` | `7d41eb1d760dc4085706c78b746c79a9b24b1cb6b9793e50b8390654f732415a` | AGG V2 caller inventory v0.5.16; 9/9 passed; 114 semantic callsite tuples preserved |
| `tests/test-agg-v2-sql-mutation-audit.mjs` | `3931dd099693029e6e3ac234db06a3dcaec12ce4f078a934abd577759fff62c8` | `b446e89428c0cab9daa3699a3acf71c3f23b36bd7b6381c79ed0747268f53a76` | SQL inventory v14 / query register v0.5.13; 13/13 passed; 1,309 callsite identities and operation counts preserved |
| `docs/agg-external-checkpoint-v2-record-event-callers-successor-20261101.md` | `90d03cb7934837aa3d0ea0f3b581447175fab145bde8832462470e25f6bf9232` | `ed9827fa0988cf8eb3e5e3f41dac2ec7c56464b8cdde14d7dd3b376c0d120677` | Append-only v0.5.16 and SQL v0.5.13 successor lineage |
| `benchmarks/adaptive-goal-graph/run-benchmark.mjs` | `433ff983cedda991fb423a6850f105ba407729c55bd32e17a54dd3b0ebd30438` | `46bd170e775bf4368cea3327bf9dc501c16fd3141fc4bc06d1183112b8ccd979` | Default fixture selector advances to v173 |
| `tests/test-adaptive-goal-benchmark.mjs` | `7acebb8663df66c703ba0e2736f25acb403316a544cce877fa71dcc4ad75c595` | `49e0ab38cc70dc87e784fe0dcfa76e5b926e979ce60a898e98fb0291ad19eb1f` | Selects v173, pins v172 immutability and migration lineage, compares all source/artifact pins |

The v172 mismatch was not a scanner defect or filesystem read inconsistency. The runner read stable regular files and reported the exact digest observed. The caller regression and its note advanced for the v0.5.15 successor; subsequent extraction work changed the Execution persistence owner, WorkflowStatePort, host composition, source inventory and relevant tests/docs. v173 records exact successor identities without rewriting v172.

## Invariants retained

- v172 and all earlier fixture bytes remain unchanged.
- The v173 fixture carries the exact SHA-256 of v172 as `migration.priorFixtureSha256`.
- Every changed source pin records the exact v172 predecessor digest in `previouslyPinnedBeforeRC72V173Sha256`.
- All unchanged source pins retain their exact v172 digest; no invented transitions.
- Graph/task/node/edge identities, evidence contract, frozen ground-truth oracle, and scoring rubric are unchanged.
- Provenance validation remains fail-closed. No hash is regenerated automatically at runtime.
- Source inventories remain lexical/local integrity evidence only, not a projection allowlist or external authority proof.

## Verification

- `node --test tests/test-agg-v2-event-callers.mjs`: 9 tests passed.
- `node --test tests/test-agg-v2-sql-mutation-audit.mjs`: 13 tests passed.
- `node --test tests/test-adaptive-goal-benchmark.mjs`: 15 tests passed after the v173 transition.
- The benchmark's negative mutation tests reach their intended assertions because all fixture source pins are valid before each isolated mutation is applied.

## Extraction-boundary successor pins

The same v173 ledger also binds the bounded Execution persistence-owner slice, AGG v0.5.16 and SQL v0.5.13 successor artifacts, and their documentation/tests. `ExecutionPersistenceStore` v1 now owns provider-run/dispatch-intent DDL and narrow read models. Host composition constructs it over the exact shared Workflow SQLite connection; `WorkflowStatePort` delegates these reads, and `ExecutionPersistenceParticipant` v1 is built from the Execution owner only after exact connection identity validation. The participant remains read-only and exposes no DB handle or transaction controls.

The Execution owner initializes its provider-run/dispatch-intent schema in its constructor; composition injects the exact shared connection but does not initialize another subsystem's schema. This does **not** transfer provider write/CAS ownership or the mixed `attempts`, `results`, `task_leases`, execution-batch, task-projection and event transaction groups. WorkflowStatePort still coordinates provider writes and cross-domain fences on the shared connection. Physical DB ownership and independent transactions remain blocked. Newly introduced source/test/docs paths have no predecessor digest; changed existing pins retain their exact v172 predecessor digest. v173 records exact current bytes without claiming historical identity or external authority.

Focused boundary validation command exited 0 across Agent Session, WorkflowStatePort, Execution persistence participant, provider admission, provider-run quarantine and M12; chained two-process dispatch/batch concurrency, deterministic recovery race, ExecutionManager, post-spawn reconciliation and lease-fencing commands also exited 0. Integrated `npm test` passed (exit 0); `docs:check`, public subsystem alignment, WorkflowStatePort suite, MCPB source alignment, package reproducibility and `git diff --check` also passed. These checks do not establish external trust/approval authority or independent physical storage ownership.
