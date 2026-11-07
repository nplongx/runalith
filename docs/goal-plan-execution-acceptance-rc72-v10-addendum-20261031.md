# RC.72 v10 source-inventory and MCPB alignment successor — 2026-10-31

The workflow-contract facade import migration added one runtime source module. The source-to-bundle alignment guard now includes `src/runtime/workflow-contracts-public-api.js`; the package collector follows its static imports from the runtime closure. MCPB source alignment and collector smoke checks pass.

The source-only V2-01 `recordEvent` inventory successor is v0.5.8. It scans 95 files and retains the same 114 callsites, 97 literal callsites, 17 computed/unresolved callsites and 71 literal event types as v0.5.7. The callsite tuples and the 17 reviewed computed-expression notes are unchanged. No event type was assigned new projection, authorization or audit-only semantics. The SQL source snapshot successor is v8; its event-query register v0.5.7 preserves 155 event-related SQL callsites across five files with operation classes unchanged (151 readers, one schema/trigger bootstrap and three writers). The inventory remains source discovery/classification, not an event allowlist or projection manifest.

Benchmark fixture v168 refreshes five exact source pins for the updated runner, benchmark regression test, MCPB verifier and V2-01 drift tests. It preserves the v167 predecessor digests and keeps the graph/scoring oracle, tasks, nodes, edges, evidence contract and scoring semantics unchanged. v167 and all earlier fixtures remain byte-for-byte preserved.

Validation:

- `node --test tests/test-agg-v2-event-callers.mjs` — PASS 8/8.
- `node --test tests/test-agg-v2-sql-mutation-audit.mjs` — PASS 12/12.
- `node tests/test-mcpb-source-alignment.mjs` — PASS.
- `node scripts/collect-plugin-runtime.mjs` staging smoke check — the new workflow-contracts facade is present in the collected runtime closure.
- `node --test tests/test-adaptive-goal-benchmark.mjs` — PASS 15/15 on v168.
- `node tests/test-subsystem-public-repo-alignment.mjs` — PASS; three public repositories and 25 mirrored source files, with host facade smoke tests.
- `npm run docs:check` — PASS; 230 Markdown files, 551 local links and 75 MCP references.
- `git diff --check` — PASS.

These are local source-integrity and regression checks only. They do not attest an independent build, production trust, external checkpoint, release approval or activation.
