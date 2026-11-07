# Parallel workstreams

Eight bounded implementation workstreams sit inside the **three deployables** accepted by [ADR 0003](../../docs/adr/0003-three-part-rust-deployment.md). They are independent development ownership areas, not eight services, binaries or databases.

Normative decomposition, contracts, dependency graph and shared rules: [Eight-part parallel plan](../EIGHT_PART_PARALLEL_PLAN.md). Historical three-deployable implementation/evidence: [Three-part implementation plan](../THREE_PART_IMPLEMENTATION_PLAN.md).

| ID | Workstream | Deployable | Brief |
|---|---|---|---|
| 1 | Workflow Catalog & Plan Compiler | Workflow Control | [01](01-workflow-catalog-compiler.md) |
| 2 | Workflow Control & Lifecycle | Workflow Control | [02](02-workflow-control-lifecycle.md) |
| 3 | Worker Runtime & Sandbox | Execution Workers | [03](03-worker-runtime-sandbox.md) |
| 4 | Provider Effects & Reconciliation | Execution Workers | [04](04-provider-effects-reconciliation.md) |
| 5 | Sessions & Artifacts | Execution Workers | [05](05-sessions-artifacts.md) |
| 6 | Governance Authority | Governance & Interface | [06](06-governance-authority.md) |
| 7 | AGG Evidence & Checkpoint Custody | Governance & Interface | [07](07-agg-evidence-checkpoint.md) |
| 8 | Gateway & Protocol | Governance & Interface | [08](08-gateway-protocol.md) |

**Ownership:** all eight briefs are unassigned until a named accountable owner is recorded. Do not infer owner identity from a crate, recent commit or chat participant.

**Current mode:** documentation/contract planning. Source and existing DB topology remain read-only. Work may proceed in parallel using mock ports, fixtures and isolated tests. D-01, signer/claim authority, cancellation settlement, recovery disposition and production migration gates remain external blockers; see the master plan.

## Contributor checklist

Before implementation, each owner must fill in an ownership record in their brief: accountable owner, branch/worktree, exact files/crates, contract version, consumer reviewers, test commands and merge gate. Shared files (`Cargo.toml`, `Cargo.lock`, `runalith-store`, `runalith-runtime`, schema migrations and common protocol types) require one coordinating owner and an explicit review window.
