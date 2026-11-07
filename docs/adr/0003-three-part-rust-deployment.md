# ADR 0003: Three independently deployable Rust parts

- **Status:** Accepted as the target decomposition; implementation and production cutover remain blocked.
- **Date:** 2026-11-01
- **Decision owner:** Project owner / maintainers
- **Supersedes:** ADR 0002 only on deployment topology. Rust language choice, Node compatibility-oracle rule, data ownership, fail-closed authority, migration and cutover constraints remain in force.

## Context

ADR 0002 selected a modular monolith as the initial implementation topology. The project now requires three independently buildable, testable, deployable and rollbackable parts. The existing Rust workspace is not yet separated: it has one MCP binary, a cross-cutting `runalith-runtime`, a shared schema-v8 Store and direct Store dependencies from execution/provider crates. Treating current crate boundaries as process boundaries would create shared-database coupling and false independence.

## Decision

Split the target runtime into exactly three deployables:

1. **Workflow Control:** workflow catalog/compiler, immutable plans, coordinator, workflow/task lifecycle, lease epochs and recovery decisions. Owns authoritative workflow state.
2. **Execution Workers:** process/sandbox execution, provider adapters and reconciliation, sessions/delivery, artifact storage and execution observations. Owns worker/provider execution facts; it cannot decide workflow authority or mutate Control state.
3. **Governance & Interface:** trust roots/policies, approval verification, AGG/evidence/checkpoint custody and MCP/API/operator gateway. Owns trust and evidence facts; gateway cannot bypass service authorization or own workflow/execution state.

Each deployable owns its database/schema and secrets. Cross-part communication uses authenticated, versioned contracts with stable identities, exact subject binding, idempotency and durable outbox/inbox. No shared database, cross-service SQL, implicit distributed transaction or circular synchronous dependency. Control alone owns workflow/task lifecycle and lease epochs; Execution alone owns execution/provider observations; Governance alone owns trust/evidence verification state.

The current 13-crate workspace may temporarily compose these interfaces in-process. That is a development compatibility mode, not independent deployment. Extract public contract ports and prove in-process behavior before introducing process/network boundaries. Three target binaries are `runalith-control`, `runalith-worker`, and `runalith-governance` with the MCP gateway hosted by Governance & Interface; these binaries do not yet exist.

## Consequences

- Each part can be released and rolled back independently only within a compatible contract window.
- Workflow, execution and governance data ownership becomes explicit; existing schema-v8 combined state must be separated through additive, verified export/import into fresh stores.
- Eventual consistency replaces assumptions of one SQLite transaction across all concerns. Durable outbox/inbox, idempotent consumers and reconciliation become mandatory.
- More operational work is required: service identity, credentials, health/readiness, observability, independent CI, schema compatibility, runbooks and per-part rollback.
- No part may treat missing lease/session metadata as worker death or retry an ambiguous provider effect.
- Node remains the read-only behavioral oracle until full parity. Production cutover, live DB migration, trust provisioning, provider dispatch and host activation require separate authority.

## Acceptance

Independent deployment is not established until each part builds/tests from a clean checkout, owns only its store, runs in a separate process, survives network partitions/restarts and duplicate/out-of-order events, passes contract and Node differential suites, proves per-part rollback without erasing durable external facts, and has independent release/authority evidence. See [`rust/THREE_PART_IMPLEMENTATION_PLAN.md`](../../rust/THREE_PART_IMPLEMENTATION_PLAN.md) for ownership, APIs, migration sequence and current blockers.
