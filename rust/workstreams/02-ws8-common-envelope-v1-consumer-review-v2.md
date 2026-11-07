# WS2 consumer review V2 — WS8 Common Envelope v1 / CR-09

**Disposition:** `CHANGES_REQUESTED_WITH_BOUNDED_ACCEPTANCE; DRAFT_NOT_RATIFIED`  
**Schema reviewed:** WS8 `08-common-envelope-v1.schema.json`, SHA-256 `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2`  
**WS8 Gateway proposal:** `08-gateway-protocol-contract-v1.md`, packaged SHA-256 `533b0c24660a9e64a435dc63268df1b848f538bb5762bee1025e492915c9faaf`  
**WS2 producer ownership:** `WorkflowCommandV1`, `WorkflowViewV1`, `TaskClaimV1`, `LeaseRenewalV1`, `TaskResultEnvelopeV1`, cancellation/recovery and lifecycle journal.

## 1. Bounded items accepted with blockers

1. **Envelope layering:** a common outer envelope can carry producer-owned domain DTOs in `payload`. `schema_version.major/minor` must remain distinct from each inner W2 schema version. `payload_digest` must not be substituted for plan, command, ACL, event, claim-authenticator, previous-event or current-event digests.
2. **Mutating commands:** `effect_class=mutating` correctly requires `idempotency_key`. The value must be forwarded to the producer's exact logical command identity and the producer must persist/replay the original outcome; Gateway cannot create idempotency by wrapping the call.
3. **Responses:** `message_kind=response` requiring `causation_id` is structurally appropriate. W2 must map it to the exact request `message_id`; correlation is not a substitute for causation.
4. **Journal ordering:** retain the existing accepted-with-blockers mapping recorded in WS8 §4.2: `ordering.stream_id=workflow_id`, `ordering.sequence=WorkflowEvent.sequence`, `ordering.predecessor_id` = immediate prior `WorkflowEvent.event_id`, null at sequence 1. Do not map it to `previous_sha256`. Payload retains both `previous_sha256` and current `sha256`. The predecessor may be supplied only from the exact verified immediately preceding journal row. If history is truncated, a sequence gap exists or predecessor cannot be verified, omit outer `ordering`; keep history `UNKNOWN`/`UNRESOLVED`.
5. **Producer/audience authority rule:** WS2 confirms `producer_id` is descriptive envelope metadata, not a credential. Control producer identity comes from host-authenticated service identity; target audience comes from authenticated route/host configuration; receiver compares authenticated peer identity and configured audience against its own identity. Caller JSON must not select producer identity, audience, capability or `effect_class`.

These are mapping rules only. They do not prove remote peer authentication, a public route, or ratification.

## 2. Blocking gaps before wire acceptance

### 2.1 Domain bytes and digest profile

The schema only constrains `payload_digest.algorithm=sha-256`, a free-form `canonicalization` string and a 64-hex value. `payload` is a generic object, not a W2 typed request/response schema. WS2 has not published immutable envelope positive/negative byte vectors for each W2 DTO. Required before ratification:

- exact inner DTO version and complete serialized payload bytes;
- producer-approved canonicalization/digest profile per domain field;
- exact payload digest golden values across Rust/Node/Python;
- changed-body-under-same-idempotency-key conflict and exact same-key replay returning the original receipt;
- distinct digest domains retained, including `PlanDigest`, `command_sha256`, `acl_sha256`, event-chain hashes and envelope `payload_digest`.

The current Store event journal hashes `serde_json::to_vec(EventHashMaterial)` with fields `workflow_id,event_id,task_id,event_type,payload_json,idempotency_key,created_at,previous_hash`. The public `WorkflowEvent` projection exposes `sequence,event_id,previous_sha256,sha256`; it does not itself include predecessor event ID. Do not infer outer payload canonicalization from this journal's internal hash construction.

### 2.2 Authentication and principal mapping

The envelope contains no authenticated principal, issuer, audience or signature field. `producer_id` is a bounded string, not proof. WS8's `McpPrincipalV1` is a request assertion paired with `AuthenticatedMcpTransportContext`, not itself a credential. W2 confirms the authority source must be out-of-band host authentication and route configuration. However no Control northbound peer-auth profile, issuer provisioning, audience registry, mTLS/session binding or Control host authority for the worker API is proven. The Gateway must not trust an envelope string as authentication.

The mapping from MCP JSON-RPC request ID to envelope `message_id`, response `causation_id`, `correlation_id`, and producer-level idempotency identity is not yet a frozen W2 DTO mapping. Publish exact request/response examples and reject principal, audience, capability or effect-class rebinding.

### 2.3 Route registry

WS8 §4.1 requires each route to specify `route_id`, owner, service ID, method/path, request/response schema IDs, supported schema-version range, required capability, side-effect class, idempotency policy, request-size/deadline limits, stable error-map version and compatibility window. W2 still has no approved public route registry row for the published domain DTOs. Local Control API paths such as `/v1/worker/claims/receive`, `/verify`, `/leases/renew`, `/results` and `/execution-fences` are implementation routes, not an approved Gateway public API mapping.

Standalone Control HTTP parser currently enforces 1,048,576-byte request bodies, 16,384-byte headers and 5-second read/write socket timeouts; it accepts only loopback binds. The worker authority is `None` in `ControlApi::from_store` unless a host explicitly injects `WorkerControlAuthority`. These local limits and routes must be reconciled with the Gateway's 1 MiB frame/service limits and per-route deadline/budget before a public registry is approved.

### 2.4 Stable errors

Current `WorkerControlError` is mapped to HTTP 400/403/409/503/500 with body `{"error":"message"}`; runtime errors similarly map to HTTP status plus free-form text. There is no frozen W2 machine-readable producer error-map version/code in these routes. The bounded W2 cause/domain diagnostic inventory is a separate DRAFT and must not be silently conflated with generic Gateway/MCP transport errors. Publish exact stable error codes and map status/retry/UNKNOWN/reconciliation semantics without deriving domain causes from HTTP status alone.

### 2.5 Version negotiation and integration

The Common Envelope schema test reports 13/13 structural checks. The standalone version-range primitive reports 8/8 but is not integrated into Gateway dispatch. Current Rust tests independently pass `cargo test -p runalith-protocol --locked --offline` (35/35) and `cargo test -p runalith-mcp --locked --offline` (67 lib +6 main +5 CLI =78/78). These validate local primitives/gateway boundaries; they do not prove the standalone negotiation primitive is wired into dispatch, a remotely authenticated service route or three-deployable integration.

## 3. Required next evidence

1. WS2 publishes exact producer-owned schema paths/versions and positive/negative envelope byte/digest vectors for each route, including command, view, claim, renewal, result and cancellation/recovery.
2. WS2 + WS3 close TaskClaim/LeaseRenewal authority, audience, replay/fence/receipt and error semantics; WS6 trust/key lifecycle remains separately appointed.
3. Project Owner names accountable WS8 and integration authority; Execution host owner provides authenticated peer identity/session binding; W2 owner approves Control service routes and host principal mapping.
4. WS8 publishes complete route registry and stable transport error map; negotiation is integrated before dispatch; limits are agreed per route.
5. WS1–WS7 sign off their respective producer payload semantics and exact bytes. A structural schema test is not producer approval.

**Overall CR-09:** `OPEN / BLOCKING`. `ordering` mapping and out-of-band audience rule are accepted narrowly with blockers. Common Envelope v1.0.0 remains `DRAFT / NOT RATIFIED`; no public Control route, remote authentication, digest profile or global wire acceptance is granted. WS8 human owner/integration authority remains `UNASSIGNED` in the reviewed proposal.
