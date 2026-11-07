# RC.72 v9 workflow-contract facade migration — 2026-10-31

The pure artifact/success contract kernel is now exposed by one host-side root facade, `src/runtime/workflow-contracts-public-api.js`, matching the curated public API of [runalith-workflow-contracts](https://github.com/nplongx/runalith-workflow-contracts). Eight runtime modules now import artifact/success functions through this facade rather than deep-importing implementation files. The package remains experimental `0.1.0`; the host uses byte-identical local source mirrors and does not fetch or install the public repository at runtime.

The package boundary is intentionally narrow: typed artifact DTO validation and hashing, success predicate normalization/evaluation, success assessment validation, and strict JSON parsing. Workflow plan/compiler, workflow definitions/catalogs, agent/role action-intent and AGG semantic policy, DB-backed policy/custom-role stores, approval, trust and execution authority remain host-owned. The full workflow subsystem is not claimed to be extracted.

Benchmark fixture v167 refreshes six exact local source hashes after the consumer-import migration and preserves v166 predecessor digests. The graph/scoring oracle, tasks, nodes, edges, recovery outcomes, evidence requirements and scoring semantics remain unchanged. v166 and earlier fixtures remain byte-for-byte preserved.

Validation:

- `node --test tests/test-adaptive-goal-benchmark.mjs` — PASS 15/15 on v167, including source drift, semantic pin, traversal/symlink/duplicate rejection and oracle-preservation checks.
- `node tests/test-subsystem-public-repo-alignment.mjs` — PASS; three public repositories, 25 mirrored source files, host facade smoke tests passed.
- `node tests/test-success-contract.js` — PASS.
- `node --test tests/test-adaptive-goal-execution-plan-candidate.js` and `node --test tests/test-adaptive-goal-execution-graph-proposal.js` — PASS (10/10 and 12/12).
- `npm run docs:check` — PASS; 228 Markdown files, 551 local links, 75 MCP references.
- Public [`runalith-workflow-contracts` CI](https://github.com/nplongx/runalith-workflow-contracts/actions) — Node 22/24 CI PASS for the public package snapshot.

These checks establish local source/test consistency only. They do not establish an independent build, production trust, release approval, external checkpoint authority or activation. The host `npm test` result must be taken from the final run after this migration; no separate artifact-store test claim is made for a direct invocation blocked by the workspace's protected-path ancestry guard.
