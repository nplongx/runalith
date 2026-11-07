# Agent Runtime and Session API

**Status:** modular-monolith boundary implemented; no standalone package or GitHub repository yet.  
**In-process API version:** `AGENT_SESSION_API_VERSION = 1`  
**Composition root:** [`src/runtime/runalith-runtime-composition.js`](../../src/runtime/runalith-runtime-composition.js)  
**SQL owner:** [`src/runtime/agent-session-store.js`](../../src/runtime/agent-session-store.js)  
**API definition:** [`src/runtime/agent-session-api.js`](../../src/runtime/agent-session-api.js)

## Responsibility

Agent Runtime owns Agent session identity and lifecycle, session access-control grants, durable inter-agent messages, deduplication, delivery claims/leases, transport receipts, ACK/retry state, uncertain delivery and restart reconciliation. It does not own Workflow approval, task status, deterministic execution authorization, provider dispatch or final Workflow terminalization.

Session persistence tables owned by `AgentSessionStore`:

- `agent_sessions`
- `session_access`
- `session_messages`

The owner defines their DDL, migrations, indexes, queries and mutations. It does not issue SQL against `jobs`, `tasks`, `events`, `attempts` or Execution tables. Workflow task locks/reads and event writes use the injected `WorkflowStatePort`.

## Public in-process API v1

The host constructs the SQL owner, validates its public domain surface with `createAgentSessionPort()`, then exposes a frozen semantic API through `RunalithWorkflowStore.agentSessions`. The public surface is explicitly enumerated in `AGENT_SESSION_API_METHODS`:

`getSession`, `getSessionByOpenClawKey`, `getSessionByTask`, `createAgentSession`, `updateAgentSession`, `heartbeatAgentSession`, `listAgentSessions`, `getSessionAccess`, `listSessionAccess`, `grantSessionAccess`, `revokeSessionAccess`, `hasSessionPermission`, `assertSessionPermission`, `attachAgentSession`, `takeoverAgentSession`, `enqueueSessionMessage`, `getSessionMessage`, `listSessionMessages`, `claimSessionMessage`, `claimNextSessionMessage`, `deliverNextSessionMessage`, `assertDurableSuccessfulSessionReceipt`, `ackSessionMessage`, `markSessionMessageDeliveryUncertain`, `retrySessionMessage`, `retryExpiredSessionMessages`, `reconcileSessionDelivery`, `recordSessionDeliveryReceipt`, `recordSessionDeliveryStarted`, `deliverSessionMessage`, `markStaleAgentSessions`, `markAgentSessionStale`, `listActiveAgentSessionsForJob`, `getSessionTraceForJob`.

The API contains semantic operations and DTOs only. It does not expose `DatabaseSync`, SQL, `WorkflowStatePort`, schema objects, store internals or host transport handles. `createAgentSessionLifecycleParticipant()` creates a separate versioned internal participant containing only `AGENT_SESSION_LIFECYCLE_METHODS` (`lockSession`, `updateRetryAttempt`, `terminateSessionsForTask`). The public domain API/port contains none of these transaction hooks; the lifecycle participant contains none of the public domain methods. Neither object exposes a DB handle.

## Composition and compatibility

`RunalithWorkflowStore` is the composition root. It creates the Workflow core, creates `AgentSessionStore` against the same SQLite connection, injects a narrow `WorkflowStatePort` and explicit delivery hooks, attaches the versioned domain query port and separate lifecycle transaction participant, and exposes the versioned public API. Both active and legacy MCP entrypoints select this host composition module.

The root `job-store.js` remains the import compatibility facade. Legacy Agent Session method names are installed only on the host `RunalithWorkflowStore` prototype and delegate through its versioned `agentSessions` API; `WorkflowStore` core declares no public Agent Session delegators and does not import or construct `AgentSessionStore`. Workflow reads session traces/active-session projections through its private domain-port injection. Retry, completion and terminalization invoke only the separate internal lifecycle participant inside the existing SQLite transaction/savepoint. These cross-owner operations are intentional host integration, not independent transaction boundaries.

## Invariants and failure semantics

- ACL grant/revoke operations validate canonical Agent roles and reject unauthorized or unsupported permissions.
- Message deduplication binds the exact request payload and recipient; key reuse with changed identity/payload is rejected.
- Claims use durable lease/CAS ownership and two-process exclusion.
- The transport-start marker distinguishes safe pre-send retry from possible external side effects.
- A successful transport receipt is durable before ACK; recovery may complete a local ACK from that exact receipt without replaying the external send.
- Once delivery may have crossed the transport boundary but no exact success receipt exists, state remains uncertain/quarantined. It is not automatically replayed.
- Retry state and corresponding Workflow event writes preserve existing transaction atomicity; crash/reopen recovery must not duplicate a delivery side effect.

## Dependencies and current extraction blockers

Current dependencies include COS-AP v1 envelope validation, the public Agent Contracts role vocabulary, strict JSON parsing, WorkflowStatePort task/event operations, host-provided delivery hooks, Workflow task/session foreign keys/references and the shared Workflow SQLite database/event journal. The public domain port and internal lifecycle participant are separate versioned objects, but both remain in-process contracts over the same connection.

`WorkflowStore` still invokes internal Agent Session lifecycle commands during retry, task completion and terminalization transactions. The host `RunalithWorkflowStore` exposes the legacy Agent method names; the core WorkflowStore class no longer declares those compatibility delegators. Session lookup/recovery consumes Workflow task identity and OpenClaw reference projections. Agent and Workflow share one physical database and rely on cross-owner transaction participation. Therefore API v1 is an in-process contract, not yet a stable external API, and the Agent Runtime is not independently extractable.

Before extraction: move remaining internal Workflow/Agent lifecycle transaction choreography into an explicit host orchestration adapter; formalize task/session references and cross-owner transition protocol; make Agent build/test closure independent from private host strict-JSON/runtime modules; preserve shared transaction behavior through named APIs or replace it with a proven idempotent protocol; add standalone clean-clone package tests and provider/consumer compatibility fixtures.

## Compatibility and versioning policy

Version 1 rejects incomplete implementations and unsupported versions at composition time. Additive methods require an explicit compatibility review; removing/renaming methods, changing DTO meaning, deduplication identity, lease fencing, receipt validation or unknown-outcome behavior requires a major API version. The current in-process v1 is experimental until independently tested, documented and released from a dedicated repository. Root `job-store.js` methods remain compatibility APIs during host migration; no database schema migration or column removal is authorized by this document.

## Tests and release gates

Primary contract/compatibility suites:

```bash
node tests/test-agent-session-store-boundary.mjs
node tests/test-session-authorization-expiry.js
node tests/test-session-enqueue-atomicity.js
node tests/test-session-delivery-boundary.js
node tests/test-agent-retry-atomicity.js
node tests/test-openclaw-runtime-attach-atomicity.js
npm run test:workflow-state-port
```

Release gate requires ACL negative cases, changed-payload dedupe rejection, concurrent/two-process claim tests, SIGKILL before/after transport effect and ACK, independent reopen, uncertain-outcome/no-replay assertions, host composition E2E, package closure, standalone CI, license/security/contribution governance, explicit deprecation window and cross-repo consumer compatibility tests. No Agent Session repository is created before those gates and shared DB/task/event dependencies are resolved.
