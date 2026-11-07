# Adaptive Goal Graph subsystem

**Target boundary:** graph search and knowledge/proposal APIs. The pure algorithm core has its own public repository; the proposed stateful runtime repository is `runalith-adaptive-goal-runtime` (see [GitHub repository target map](github-repository-target-map.md)). AGG as a whole is not one independent service today. Persistent knowledge, trust verification and workflow integration remain separate host-owned boundaries until their APIs and data ownership are complete.

## Current implementation

The pure graph/discriminator modules `adaptive-goal-graph.js`, `adaptive-goal-discriminator.js`, `adaptive-goal-phase2-search.js`, `adaptive-goal-phase2-dataset.js`, `adaptive-goal-phase3-mcts.js` and canonical JSON helper are extracted to [runalith-adaptive-goal-graph-core](https://github.com/nplongx/runalith-adaptive-goal-graph-core). Stable Phase 1 APIs are exported at package root; Phase 2/3 remain explicitly experimental under `./experimental`. Host-only candidate evidence assessment and source/artifact resolution are not public exports. `adaptive-goal-phase2-plan-shadow.js` and its workflow-facing adapter remain in the host.

Knowledge and integration include `adaptive-goal-knowledge-store.js`, `adaptive-goal-knowledge-capture.js`, `adaptive-goal-plan-adapter.js`, `adaptive-goal-compatibility.js`, `adaptive-goal-execution-readiness.js`, `adaptive-goal-execution-graph-proposal.js`, `adaptive-goal-reviewed-task-inputs.js` and `adaptive-goal-execution-plan-candidate.js`.

Trust, evidence and approval are covered by the separate [trust/evidence boundary note](trust-evidence.md).

## Internal decomposition

1. **Graph core:** validation, canonical graph representation, conditional recovery recommendations, bounded search and offline discriminator algorithms. Extracted as a pure public package. Evidence-reference resolution/attestation remains a host responsibility.
2. **Knowledge store:** append-only nodes, revisions, memberships, edges and snapshot APIs. The target AGG runtime repository owns persistent knowledge; its storage port and WorkflowStore decoupling remain required.
3. **Planning integration:** projection into workflow templates and review-only Plan/Execution Graph proposals. It should depend on Workflow Contracts through a public versioned API, never internal workflow paths.
4. **Host adapter:** artifact/source/producer-lineage resolution, durable events, guard registration and sandbox fixture handling remain in the host until their ports are explicit. The current sandbox executor is fixture-only and is not a production arbitrary-code sandbox.

The active MCP composition no longer owns anonymous AGG `BEGIN`/`COMMIT`/`ROLLBACK` statements. [`AdaptiveGoalTransactionBoundary`](../../src/runtime/adaptive-goal-transaction-boundary.js) now provides distinct named transaction lifecycles for Plan Graph create, Execution Graph create/read, Execution Plan Candidate create/read, Readiness preview and sandbox action claim. Source verification, idempotency, proposal/event writes and exact readback still execute in the MCP use case while the same SQLite transaction is held. This is a transaction seam, not yet an extracted `AdaptiveGoalProposalService` or `AdaptiveGoalSandboxService`.

## Candidate public API

- `validateGraph(graph)`
- `searchGraph(graph, query, options)`
- `classifyEvidenceReference(reference)`
- `createKnowledgeSnapshot(goalId, options)`
- `projectCandidateToPlan(candidate, workflowContract)`
- `buildExecutionGraphProposal(reviewedCandidate)`

The graph-core public API is pinned in its [API reference](https://github.com/nplongx/runalith-adaptive-goal-graph-core/blob/main/API.md). Current root exports include `validateAdaptiveGoalGraph`, `searchAdaptiveGoalGraph`, `resolveAdaptiveGoalRecovery`, discriminator feature extraction/scoring/training and strict model validation. Phase 2 dataset/model/search and Phase 3 MCTS are imported through `@runalith/adaptive-goal-graph-core/experimental`. Evidence/artifact verification, snapshot identity and workflow-plan projection remain separate host APIs. Phase 2/3 algorithms are shadow/research only and cannot authorize execution.

## Coupling and authority blockers

- AGG plan integration imports workflow plan/artifact/agent contracts; reverse coupling also exists because workflow agent contracts import AGG action-intent policy.
- Knowledge storage and telemetry are initialized on the workflow database. Proposal/candidate records are written to the workflow event store.
- The host resolves artifact and producer lineage using workflow-owned state. AGG must call a read-only evidence port, not inspect the workflow database directly.
- A knowledge snapshot marked verified is not a workflow approval. An AGG proposal is review-only and must continue through normal workflow compilation, immutable plan approval and dispatch gates.

## Extraction gate

Graph algorithms are extracted to [runalith-adaptive-goal-graph-core](https://github.com/nplongx/runalith-adaptive-goal-graph-core) (`0.1.0`, public CI passed; not published to npm and not automatically synchronized with host source). Next extract named proposal/candidate and sandbox use cases around the existing transaction boundary; preserve source freshness, fingerprint idempotency, readback and one-shot claim/recovery behavior. Do not move knowledge storage, reviewer/trust verification or approval into the graph-core repository until storage ownership, current-snapshot verification and event integration have independent contracts and negative tests.
