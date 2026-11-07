# Workstream 8 — Gateway & Protocol contract proposal v1

**Status:** DRAFT / NOT RATIFIED. This is a documentation and schema-fixture proposal only.
**Accountable owner:** UNASSIGNED (per `08-gateway-protocol.md`).
**Consumer approval:** W1–W7 producer owners and the three-deployable integration owner are pending.
**Authority:** `EIGHT_PART_PARALLEL_PLAN.md` and ADR 0003. This proposal does not alter deployment topology, D-01, persistence ownership, service authority or rollout gates.

This file is a concrete contract-first starting point for Workstream 8. It is not permission to edit shared Rust modules, manifests, database schemas or service implementations. The JSON Schema and example beside this file are proposed wire artifacts; producer owners must approve domain semantics and the common version before they become binding.

## 1. Boundary and layering

Workstream 8 owns the northbound interface and shared wire mechanics only:

- public MCP/HTTP/CLI presentation, route registry and service-client composition;
- common envelope metadata, serialization, schema publication and version negotiation;
- caller-principal propagation, capability presentation, request limits and transport error mapping;
- forwarding the caller's mutation idempotency key unchanged to the service that owns the mutation;
- compatibility fixtures and Gateway tests against mock service ports.

The producer workstream owns the meaning, required domain fields, authoritative state transitions and domain error semantics of its messages. The receiving service must authenticate and authorize again. Capability filtering is discovery/presentation, not an authorization decision.

The Gateway must not import another service's private domain module, read or write its database, infer business outcomes, execute providers/workers, or claim a distributed transaction. Workstreams remain inside the three deployables defined by ADR 0003; this does not create an eighth service.

Three contract layers must remain distinct:

1. **Common message envelope** — stable cross-part identity, trace, subject, digest and optional ordering metadata. Draft schema: [`08-common-envelope-v1.schema.json`](08-common-envelope-v1.schema.json).
2. **Gateway-to-service request/response** — transport-neutral operation, authenticated principal, capability and explicit side-effect class. Existing Rust starting point: `crates/runalith-protocol/src/mcp_service_v1.rs`.
3. **Producer domain DTOs** — `CompiledPlanV1`, `TaskClaimV1`, `ProviderTerminalProofV1`, `ArtifactRefV1`, `ApprovalDecisionReceiptV1`, `EvidenceManifestV1`, etc. Their producer owns their semantics; W8 only serializes/routes them.

The proposed common envelope does not replace or silently widen `McpServiceRequestV1`/`McpServiceResponseV1`. A later integration patch must define the explicit mapping between these layers and be reviewed by their owners.

## 2. Common envelope v1 draft

The schema proposes `schema_version: { major: 1, minor: 0 }`. Unknown or unsupported major/minor versions fail closed. A consumer must advertise its supported version range before dispatch; it must not guess a schema from payload shape or strip fields to make an unknown version fit.

| Field | Draft rule | Owner / constraint |
|---|---|---|
| `schema_version` | Explicit `major` and `minor`; initial proposal is 1.0. | W8 publishes compatibility metadata; consumers reject unsupported versions. |
| `message_kind` / `message_type` | Command, event or response plus a namespaced type. | Producer owns the type vocabulary and semantics. |
| `message_id` | Stable unique message identity; unchanged across retries. | Producer/transport adapter; duplicate identity with changed digest conflicts. |
| `producer_id` | Authenticated service identity, never caller-supplied display text. | Host transport/service identity provider. |
| `created_at` | RFC 3339 UTC timestamp ending in `Z`. | Diagnostic metadata only; not an ordering or fencing proof. |
| `correlation_id` | Stable request/workflow trace identity. | Originating request context; preserve through Gateway hops. |
| `causation_id` | Optional message/request that caused this response or event. | Producer; required linkage policy is domain-owned. |
| `effect_class` | `read_only`, `mutating` or `observation`. | Route registry derives expected value; caller declaration is not trusted. |
| `idempotency_key` | Required for every mutating request/side effect. | Originator supplies it; Gateway forwards unchanged; owner service persists and enforces it. |
| `subject` | Exact typed subject identity plus relevant bindings. | Producer defines which workflow/task/plan/attempt/lease/owner-epoch/provider-run/artifact/candidate/action fields are mandatory. |
| `payload_digest` | SHA-256 of exact immutable payload bytes under a named canonicalization profile. | Producer owns canonicalization and subject binding; digest mismatch fails closed. |
| `ordering` | Optional stream identity, sequence and predecessor. | Include only when the producer's authoritative journal/checkpoint defines ordering. |
| `payload` | Producer-owned JSON object. | W8 validates envelope size/shape; it does not reinterpret domain facts. |

`08-common-envelope-v1.example.json` is illustrative only. Its digest covers the exact minified UTF-8 JSON bytes documented in that example; production canonicalization profiles and domain subject bindings require producer approval.

### Serialization, replay and ordering

- Preserve the exact immutable request bytes or the producer-approved canonical representation used to calculate `payload_digest`; do not normalize domain payloads in the Gateway.
- Persist the owning service's inbox/idempotency identity before acknowledging durable acceptance. The Gateway itself is not a substitute for that durable record.
- Same idempotency scope + same canonical payload returns the original logical result/receipt. Same key + changed payload is a conflict, never an overwrite.
- Same `message_id` + same digest is a duplicate delivery; same `message_id` + different digest is a conflict/security event.
- For ordered streams, validate `stream_id`, `sequence` and predecessor continuity. A gap, fork or conflicting predecessor remains pending/UNKNOWN or is rejected according to the producer's contract; do not sort by wall-clock timestamp.
- Duplicate, delayed and out-of-order responses must be safe. A response must bind to the original request identity and authenticated service identity.
- Do not claim a distributed transaction across Workflow Control, Execution Workers and Governance & Interface.

## 3. Authentication, authorization and capabilities

1. A trusted host/transport adapter authenticates the peer and creates a transport context before parsing caller-controlled MCP/HTTP payloads.
2. The adapter binds `subject`, `issuer`, `audience` and an opaque authentication-context reference to that authenticated transport. Raw bearer credentials are never copied into the envelope or logs.
3. The Gateway validates the exact audience/service route and derives the expected side-effect class from a service-owned route registry. It must not trust caller-supplied capability/effect claims as proof of authority.
4. The owning service independently authenticates the Gateway/client identity and reauthorizes the exact operation, subject and payload before executing it.
5. Capability discovery returns only the capabilities visible to that principal, with exact identifiers and operation/effect classes. A listed capability does not grant future authorization by itself.
6. A read-only route uses a read-only service method/port and cannot fall through to a mutating handler. Unknown route, principal, audience, capability or effect classification fails closed.

The current `McpPrincipalV1` is a request assertion paired with `AuthenticatedMcpTransportContext`; it is not itself a credential or proof. A concrete remote HTTP client, mTLS/session binding and service-side verification profile still require owner decisions.

## 4. Route registry and producer ownership inventory

Do not invent public HTTP paths or assign a whole mixed crate to W8. Each row must be completed by the producer owner before Gateway routing is implemented. The registry record for each approved route must include:

`route_id`, `owner_workstream`, `service_id`, `method`, `path_template`, request/response schema IDs, supported schema-version range, required capability, side-effect class, idempotency policy, request-size/deadline limits, stable error-map version and compatibility window.

| Producer | Domain contracts to publish (from master plan) | Public service route / exact schema path | W8 status |
|---|---|---|---|
| W1 Catalog & Compiler | `WorkflowDefinitionV1`, `RoleDefinitionV1`, `SkillPinRefV1`, `CompiledPlanV1`, `PlanDigestV1` | Owner must publish | BLOCKED — owner contract/route not received |
| W2 Control & Lifecycle | `WorkflowCommandV1`, `WorkflowViewV1`, `TaskClaimV1`, `LeaseRenewalV1`, `TaskResultEnvelopeV1`, `CancellationRequestV1`, `RecoveryDispositionV1` | Owner must publish | BLOCKED — authority, receipt and route approval pending |
| W3 Worker Runtime & Sandbox | `WorkerClaimAcceptedV1`, `ProcessObservationV1`, `ProcessStopReceiptV1`, `WorkerHealthV1` | Owner must publish | BLOCKED — local stop observation must not imply provider terminality |
| W4 Provider Effects | `ProviderDispatchRequestV1`, `ProviderDispatchObservationV1`, `ProviderRunRefV1`, `ProviderTerminalProofV1` | Owner must publish | BLOCKED — timeout-after-send remains UNKNOWN |
| W5 Sessions & Artifacts | `SessionRefV1`, `SessionDeliveryRequestV1`, `SessionDeliveryReceiptV1`, `ArtifactRefV1`, `ArtifactManifestV1`, `ArtifactLineageV1` | Owner must publish | BLOCKED — execution-owned record/API boundary pending |
| W6 Governance Authority | `ApprovalRequestV1`, `ApprovalDecisionReceiptV1`, `TrustSnapshotRefV1`, `ReviewerAttestationV1`, `TrustedSkillResolutionV1`, `NonceConsumptionReceiptV1` | Owner must publish | BLOCKED — production trust/signing authority remains external |
| W7 AGG Evidence & Checkpoint | `EvidenceSnapshotV1`, `EvidenceManifestV1`, `ProducerLineageV1`, `SourceVerificationRequestV1`, `SourceVerificationReceiptV1`, `CheckpointOperationV1`, `CheckpointHeadV1` | Owner must publish | BLOCKED — no evidence/checkpoint truth may be inferred by Gateway |

For each row the producer must confirm required subject bindings, immutable payload/digest rules, error vocabulary, idempotency scope, ordering semantics, version compatibility and a named consumer reviewer. W8 may propose transport shape but cannot approve another workstream's domain contract.

## 5. Stable error vocabulary proposal

Use stable machine-readable codes; transport-specific status codes are mappings, not new domain meanings. The exact HTTP/JSON-RPC mapping table remains pending transport and producer review.

| Proposed code | Meaning | Required client behavior |
|---|---|---|
| `REQUEST_INVALID` | Malformed request or invalid field. | Correct request; do not retry unchanged. |
| `SCHEMA_UNSUPPORTED` | Major/minor version not negotiated or supported. | Negotiate/use a supported schema; do not downgrade by deleting fields. |
| `AUTHENTICATION_FAILED` | Host could not authenticate the principal. | Re-authenticate; do not infer identity from request JSON. |
| `AUTHORIZATION_DENIED` | Exact action/subject/capability is not authorized. | Do not retry without changed authority. |
| `ROUTE_NOT_FOUND` | No approved route for the requested operation. | Treat as unsupported; no fallback to private APIs. |
| `IDEMPOTENCY_CONFLICT` | Key was already used with a different request digest. | Stop and resolve the conflicting request. |
| `MESSAGE_TOO_LARGE` / `RATE_LIMITED` | Gateway/transport safety limit exceeded. | Follow explicit limit/retry metadata only. |
| `SERVICE_UNAVAILABLE` / `DEADLINE_EXCEEDED` | Service could not complete before a safe outcome was known. | For a mutation, reconcile by idempotency key before retry. |
| `MUTATION_OUTCOME_UNKNOWN` | Mutation may have committed; no authoritative result is available. | Never automatic-retry; query/reconcile through the owning service. |
| `INTERNAL_ERROR` | Unexpected failure without a safe public detail. | Do not expose secrets or private implementation details. |

An ambiguous mutation must never be converted into definite rejection or a retryable failure merely because the transport timed out or its response was malformed. It must retain an explicit UNKNOWN result until the owning service reconciles durable state.

## 6. Existing implementation audit (source review, not acceptance)

The following are observed in the current checkout; this section is not a claim that Workstream 8 has passed independent acceptance:

| Area | Existing evidence in source | Gap / limitation |
|---|---|---|
| Service request DTO | `crates/runalith-protocol/src/mcp_service_v1.rs` defines strict `McpServiceRequestV1` with schema version, request/correlation IDs, principal, operation, capability, effect class, name, arguments and optional idempotency key. | Current version is a single integer (`1`), not the proposed major/minor common envelope; no common producer/time/subject/digest/ordering envelope. |
| Service response DTO | `McpServiceResponseV1` binds `request_id` and `service_id`, with `success`, `denied`, `failed` and `unknown` outcomes. | No cross-service schema registry or shared version negotiation observed. |
| Gateway boundary | `crates/runalith-mcp/src/service_gateway.rs` has no Store/Runtime/provider imports; it authenticates a separate transport context, checks audience, derives route effect class, reauthorizes, separates read-only/mutating methods and validates response binding. | `McpApplicationService` is an abstraction; concrete remote service clients and approved per-service route registry are not yet established by the files reviewed. |
| Ambiguous mutation | Gateway returns `MUTATION_OUTCOME_UNKNOWN` when a mutating service invocation has an error or invalid response. | Owner service must provide durable query/reconciliation and idempotency; Gateway cannot manufacture it. |
| Local MCP host | `crates/runalith-mcp/src/main.rs` composes `with_local_read_only_gateway`; `lib.rs` documents host-authenticated OS peer context and denies mutation with `MUTATION_IDEMPOTENCY_UNAVAILABLE` (`automatic_retry=false`, `handler_invoked=false`). | This is local host identity/read-only composition, not proof of remote Control/Execution authentication or an HTTP northbound facade. |
| Limits | MCP frame and service message contracts each currently cap serialized input at 1,048,576 bytes. | Confirm a common limit and per-route deadline with producer/transport owners before freezing the public contract. |

## 7. Compatibility and acceptance matrix

These tests are required before W8 can be marked accepted. Tests against mocks are useful contract evidence, not proof of a production multi-process deployment.

| Check | Expected invariant | Current status |
|---|---|---|
| JSON Schema positive/negative fixtures | Valid v1.0 accepted; malformed, missing, extra top-level and unknown/newer version rejected. | DRAFT fixture; validation pending |
| Producer identity spoofing | Caller JSON cannot replace authenticated producer/principal context. | Partial local source path; remote boundary pending |
| Wrong audience / capability | Exact audience and capability mismatch denied before dispatch. | Existing Gateway checks; test rerun pending |
| Read-only separation | Read-only resource/prompt/route never invokes mutating service method. | Existing Gateway split; test rerun pending |
| Mutation idempotency | Key forwarded unchanged; same key+same digest replays; changed body conflicts. | Host intentionally blocks mutation without durable adapter; owner implementation pending |
| Ambiguous mutation | Timeout/invalid response after invocation begins yields UNKNOWN and no automatic retry. | Existing Gateway fallback; owner reconciliation pending |
| Response binding | Wrong request ID, schema version or service identity is rejected. | Existing response validator; test rerun pending |
| Ordering | Duplicate, delayed, gap, fork and out-of-order event fixtures preserve source-journal semantics. | Common ordering envelope not implemented |
| Isolation | No direct Store/private-module/database dependency from Gateway crate. | Source review indicates no Store/Runtime imports in `service_gateway.rs`; build/lint evidence pending |
| Three-deployable integration | Gateway calls only public service APIs; no eighth deployable or cross-service SQL. | Not implemented / architecture gate pending |

Suggested focused commands (run from `rust/` after schema fixtures are wired into the repository's test harness):

```sh
cargo test -p runalith-protocol --locked --offline
cargo test -p runalith-mcp --locked --offline
cargo clippy -p runalith-protocol -p runalith-mcp --all-targets --locked --offline -- -D warnings
cargo fmt -p runalith-protocol -p runalith-mcp -- --check
```

Passing a crate test suite alone does not prove a remotely authenticated API, three separate deployable processes, database isolation, failure recovery, release or rollback.

## 8. Required owner decisions before source integration

1. Name an accountable W8 owner and confirm the exact owned files/crates and branch/worktree. The existing W8 brief explicitly leaves these unassigned.
2. Assign a single coordinating owner for shared `runalith-protocol`, `runalith-mcp`, Cargo manifests and lockfile; publish a reviewed patch window.
3. W1–W7 owners publish exact domain schema paths/versions, route paths, subject binding, idempotency and error/ordering semantics; each producer reviews its mapping.
4. Ratify or revise common envelope v1.0, digest canonicalization profiles, size/deadline limits and supported-version negotiation rules.
5. Ratify remote principal issuance, service audience, capability model, service-to-service authentication and mutation reconciliation routes.
6. Approve the compatibility test matrix and the three-deployable integration/rollback gate under ADR 0003.

Until these decisions are recorded, keep source integration, shared manifests, database/schema changes, credentials, dispatch, deployment and cutover blocked. D-01 and all external gates in the master plan remain unchanged.
