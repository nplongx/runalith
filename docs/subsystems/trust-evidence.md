# Trust and evidence subsystem

**Risk:** high. This boundary carries verification, reviewer identity, approval evidence, producer lineage and security-critical state. It must be decomposed behind explicit interfaces, not moved as a folder-level refactor.

## Current implementation

Relevant modules include `adaptive-goal-trust-configuration.js`, `adaptive-goal-trust-domains.js`, `adaptive-goal-knowledge-verifier.js`, `adaptive-goal-reviewer-identity.js`, `adaptive-goal-approval-subsystem.js`, `adaptive-goal-source-evidence.js`, `adaptive-goal-evidence-lineage.js` and `agg-checkpoint-jcs-v2.js`.

## Proposed bounded capabilities

- **Trust configuration:** load/validate administrator-provisioned providers, public roots, scope and configuration history.
- **Source verification:** verify the exact current knowledge snapshot and evidence manifest against an independent verifier decision.
- **Reviewer identity:** validate an independently administered identity provider's assertion bound to a candidate and action semantics.
- **Approval evidence:** bind policy/reviewer evidence to the exact workflow proposal and immutable plan. Do not equate reviewer attestation with workflow approval.
- **Evidence lineage:** resolve successful producer result, attempt, task, artifact and completion-event relationships.
- **Checkpoint interface:** represent independently protected monotonic checkpoint decisions; local hashes or SQLite ledgers are not substitutes for independent custody.

## API boundary rules

Public APIs accept exact scope/hash/provider/root/version/nonce data and return typed verification decisions with stable error codes. They must not export private keys, raw mutable DB handles, event-ID construction, process-local authorization markers or host workflow guards. Serialized JSON is data, not an authority token.

The external verifier, reviewer identity provider, administrator trust-root provisioning and external checkpoint custodian remain distinct trust roles. An API abstraction must not collapse them into one package administrator or one signing key.

## Current coupling and blockers

- The source verifier resolves current snapshot/evidence through host-provided resolver ports. Trust configuration/history has a separately managed connection, but the accepted V2 normative D-01 contract requires that connection and Workflow state connection to target the same single physical database selected by canonical `WORKFLOW_DB`. The active entrypoint still opens `agg-trust-configuration.db`; D-01 therefore remains open. Repository extraction must not preserve or legitimize that separate-file arrangement, and no production database migration is authorized by this document.
- Reviewer identity ingestion records durable facts in workflow events and checks the workflow database transaction boundary. It is therefore not an independent service today.
- Approval uses workflow canonical plan hashing and workflow state/event semantics.
- Security-critical events are append-only and guarded by WorkflowStore; their custody and transaction ordering cannot be changed by package extraction alone.
- Current external checkpoint and cross-database consistency questions remain explicit release/design gates. A repository split does not resolve them.

## Extraction gate

Require an owner for each trust authority; independently administered provider/root configuration; data ownership and custody evidence; atomicity/compensation/recovery design; anti-replay, rotation, revocation, malformed input and rollback tests; and a security review independent of implementation. Until then, keep this code in-process and fail closed.
