# RC.72 v8 benchmark source-provenance successor — 2026-10-31

The RC.72 v7 source tree changed after benchmark fixture v165 was created. The changed bytes included the generated MCP tool reference, documentation index, package scripts/metadata, active MCP composition, runtime modules and their regression tests. The benchmark runner correctly rejected v165 before execution because its exact source pins no longer matched the current worktree. Historical v165 was not edited.

Fixture v166 is a source-identity successor of v165. It refreshes the 15 changed SHA-256 pins and preserves each v165 digest in `previouslyPinnedBeforeRC72V166Sha256`. Existing source claim text remains descriptive context only; the refresh does not independently review or attest the semantics of every pinned module. The fixture keeps the same graph schema, fixture identity, tasks, nodes, edges, recovery conditions, evidence requirements, ground-truth paths and scoring rubric. It is local engineering evidence only, not release authority.

Validation:

- `node --test tests/test-adaptive-goal-benchmark.mjs` — PASS 15/15 on v166. This includes exact current source pins, predecessor identity, semantic-scope pinning, malformed path/symlink/duplicate rejection, deterministic search output, fixture oracle and exclusive output publication.
- v165 predecessor bytes remain SHA-256 `486c69fa08d00912d1c9d6ee2bf8aa4fbfd1229cf3f8c10a2eb31ddecd78bc50`.
- v166 preserves the frozen graph/scoring oracle; no measured quality improvement or operational execution claim is made.

The benchmark is not a trust attestation, independent rebuild, external checkpoint, release approval, production authorization or activation decision. The RC.23 gates and D-01 remain governed by their existing owners and evidence contracts.
