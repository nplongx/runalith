# Workstream 8 — Gateway & Protocol

**Deployable:** Governance & Interface. **Status:** proposed boundary; owner unassigned. See the [master eight-part plan](../EIGHT_PART_PARALLEL_PLAN.md).

Draft contract artifacts (not ratified; source integration remains gated): [Workstream 8 contract proposal v1](08-gateway-protocol-contract-v1.md), [common envelope JSON Schema](08-common-envelope-v1.schema.json), and [example envelope](08-common-envelope-v1.example.json).

## Mandate

Expose stable authenticated interfaces to users/operators and route requests to the service that owns each decision. The Gateway is not a privileged business layer.

## Ownership

- Common versioned wire envelope, error vocabulary, schema/version negotiation and compatibility fixtures.
- MCP tool/resource/prompt schemas, public HTTP/API facade and CLI/operator interface.
- Capability filtering/discovery, authenticated principal propagation and request validation/limits.
- Mutation idempotency propagation, read-only diagnostics and service routing.

## Explicit non-ownership

No workflow/worker/provider/approval/evidence business rule; no authoritative service database; no cross-service SQL; no privilege to bypass the target service's auth, idempotency or verification checks.

## Current code map

`runalith-protocol`, `runalith-mcp` Gateway composition, MCP transport/semantic parity docs and public transport adapters. `runalith-control-api` is the Control service API owned by workstream 2; workstream 8 owns northbound Gateway/facade behavior, not Control lifecycle handlers or database.

## Contract ownership rule

The producer workstream owns the meaning, required fields and state/error semantics of its domain messages. Workstream 8 owns shared envelope metadata, wire serialization, version registry, OpenAPI/JSON Schema publication, MCP/client mapping and compatibility tests. A protocol schema cannot silently redefine the producer's semantics.

## Public outputs

Persistence-free common envelope and error contracts; published wire schemas and MCP tool definitions; authenticated routes to public APIs of workstreams 1–7. Gateway must delegate mutations and carry the caller's idempotency key to the owning service.

## Parallel development

OpenAPI/JSON schemas and examples; tool inventory/differentials; version negotiation; mock HTTP clients; auth/capability negative tests; route/error mapping. Gateway can progress against mocks before the service implementations are available.

## Acceptance

1. No service database/private-module dependency.
2. Caller identity cannot be spoofed; each request carries host-authenticated principal/capability context.
3. Read-only route cannot invoke mutation methods; mutation delegates idempotency and authorization to owner service.
4. Unknown/newer incompatible schema fails closed; duplicate/out-of-order responses are handled safely.
5. Tool/schema compatibility tests and independent Gateway build; no bypass or silent contract widening.

## Ownership record — fill before coding

| Field | Value |
|---|---|
| Accountable owner | UNASSIGNED |
| Branch/worktree | TBD |
| Exact files/crates | TBD; coordinate shared `runalith-protocol` |
| Contract version | Common envelope v1 (draft) |
| Consumer reviewers | All seven producer/consumer workstreams |
| Acceptance commands/evidence | TBD |
