# ADR 0001: Decompose Runalith through a modular monolith first

- **Status:** Accepted as the migration strategy; individual subsystem boundaries remain provisional until their contract gates pass.
- **Date:** 2026-10-31
- **Decision owners:** Runalith maintainers

## Context

Runalith has identifiable workflow, execution, Adaptive Goal Graph, trust/evidence, protocol and MCP adapter concerns. The codebase already contains runtime modules, but the primary MCP entrypoint remains a large versioned monolith. Several modules directly share `WorkflowStore.db`, read/write the same lifecycle tables and rely on coordinated SQLite transactions.

AGG also depends on workflow plan/artifact/agent contracts and host-owned artifact/evidence resolvers. Trust/reviewer verification and workflow approval bind to different authorities and state stores. A folder or Git repository split alone would not make these dependencies independent.

## Decision

1. Establish bounded contexts, public APIs, documentation and data ownership inside the existing repository first.
2. Keep the application as a modular monolith while boundaries are enforced and consumers migrate to public entrypoints.
3. Extract independent packages/GitHub repositories only after their API, tests, docs and dependency direction are stable.
4. Extract processes or databases only after each stateful subsystem owns its data and cross-subsystem consistency/recovery semantics are explicit.
5. Start with the low-coupling COS-AP contract package. Do not begin by splitting workflow execution, AGG trust or approval into separate services.
6. Preserve the existing approval, immutable-plan, evidence-lineage, dispatch, lease and recovery invariants throughout migration.

## Alternatives considered

### Immediate microservice split

Rejected. Current workflow/execution/AGG paths share transaction and persistence boundaries. A network boundary would turn local atomic operations into distributed workflows before operation identity, outbox, idempotency, compensation and recovery ownership are specified.

### One repository per folder immediately

Rejected. Current folders do not map cleanly to bounded contexts; AGG and workflow have reverse imports, and several runtime modules use a shared database handle. This would create repositories with hidden coupling rather than independent subsystems.

### Keep one monolith and only document modules

Rejected as the end state. It does not enforce stable public APIs or independent contribution/release lifecycle. Documentation and contract-first packages are the first migration stage, not the final separation.

## Consequences

### Positive

- Decomposition can be incremental and reversible.
- Public APIs and contract tests appear before a remote/service dependency is introduced.
- Data/authority ownership becomes explicit and testable.
- The first low-coupling contract package can be independently built and tested.

### Costs and constraints

- Temporary adapter/facade code may exist while consumers migrate.
- Some candidates remain in-process longer than a pure package layout might suggest.
- GitHub repository extraction and release automation happen later than local API scaffolding.
- Shared-database subsystems remain blocked from independent deployment until transaction ownership changes.

## Verification criteria

- Each candidate has one owner, documented API and explicit data ownership.
- Import-boundary tests prevent new reverse/deep dependencies.
- Contract tests cover both provider and actual consumer interactions.
- Cross-subsystem operations have explicit idempotency and failure/recovery semantics.
- No approval, trust, lineage, dispatch or release invariant is weakened by extraction.
