# WS2 consumer review V3 — WS8 typed Gateway reference dispatcher / CR-09

**Disposition:** `ACCEPTED_WITH_BLOCKERS_FOR_REFERENCE_DISPATCH_SEMANTICS_ONLY; DRAFT_NOT_RATIFIED`  
**Code:** WS8 `08-gateway-dispatch.rs`, SHA-256 `a8aa17432e7b5ec7aa37dee92b552c4ae3e3ad09eb567f53a93493833be458bb`  
**Node/Rust probe:** `a59adf2d9bad7704aa9e8b669c88ad9d2a968b10cd3573e443d657655ed182cd`  
**Node differential:** `b07f13204f2d21f47cb1081395f479ceeb6e73945e768b2c29cf91b3ace3adc1`

## 1. Independent test execution

WS2 independently ran from `/home/long/work/chatgpt-adapter-ws8-20261103`:

`rustc --edition=2021 --test -D warnings rust/workstreams/08-gateway-dispatch.rs -o <temp>/gateway-dispatch-tests && <temp>/gateway-dispatch-tests`

Result: **31 passed, 0 failed**.

`node rust/workstreams/08-gateway-dispatch-v1-node-differential.test.mjs`

Result: **5/5 PASS**.

The temporary binary was created outside the WS8 worktree and removed after execution. No WS8 file modified.

## 2. Bounded behavior accepted with blockers

1. Version range is checked before route lookup, authentication and service calls.
2. `HostTransportContext` is injected by the transport adapter; `producer_id` is checked against host-authenticated peer identity rather than accepted as a credential.
3. Route derives `service_id` (audience), capability and effect class; envelope cannot downgrade/upgrade route effect.
4. `PayloadDigestVerifier` receives exact producer-canonical payload bytes. Gateway does not reserialize domain payload to manufacture digest.
5. Mutating request requires an idempotency key and forwards it unchanged to the owning service.
6. Replay port is keyed by envelope `message_id` + payload digest; exact duplicate returns original response; changed digest conflicts. Cached replay still re-verifies payload bytes.
7. Ordering metadata is checked by the owning service, not synthesized from timestamps or Gateway shadow journal.
8. Ambiguous mutating failure maps to UNKNOWN / non-retryable; Gateway does not automatically retry.
9. `project_gateway_error` preserves producer `domain_code` and `cause_code` as separate fields without rewriting.
10. Response binding helper requires exact request `message_id` as `causation_id`, same correlation, same version and route service as producer.

## 3. Producer-specific blockers

- Replay port is injected and only mock/in-memory behavior is tested. Durable atomic replay, crash recovery and reconciliation of a service mutation committed before Gateway reply persistence remain unproven.
- Envelope replay uses `message_id`; domain idempotency key is separately forwarded to service. W2 requires the owner service to enforce the exact mapping to `renewal_id`, Control fence reservation idempotency identity or another producer-owned ID. Distinct message IDs with the same inner idempotency key must not create duplicate effects.
- `validate_response_binding` exists but is not invoked inside `dispatch`. Real response-envelope serialization and `runalith-mcp` JSON-RPC ID -> envelope message/causation/correlation/idempotency mapping remain absent.
- `Route` lacks route ID, request/response schema IDs and version ranges, idempotency policy, per-route payload/deadline limits, stable error-map version and compatibility window. Therefore this source is not the completed WS8 route registry required by §4.1.
- Digest and principal verifiers are injected ports; no production cryptographic verifier, remote peer authentication profile or durable auth/replay service exists.
- Mutating `ServiceResult::Failed` is conservatively converted to UNKNOWN but drops the original service `code/message` in that branch. Preserve producer domain/cause codes separately from the Gateway UNKNOWN classification.
- Code is reference-only and not imported by live `runalith-mcp`/`runalith-protocol`. No route or three-deployable integration is proven.

## 4. W2 mapping constraints

- Outer `message_id` is not inner W2 `renewal_id`, fence `idempotency_key`, event ID or provider idempotency key. Map explicitly and keep all identities/digest domains distinct.
- Outer `payload_digest` is not W2 `request_sha256`, `acl_sha256`, `event_sha256`, `outcome_sha256`, `completion_sha256`, W4 `payload_sha256` or `request_binding_sha256` except when a producer-approved byte profile says they cover exactly the same bytes.
- Outer `ordering` mapping remains the accepted-with-blockers rule: stream ID = workflow ID; sequence = committed workflow event sequence; predecessor = immediately preceding event ID; never previous hash. W2 owning service must verify sequence/predecessor against its authoritative journal. Missing/truncated/unverifiable history remains UNKNOWN/UNRESOLVED.
- Ambiguous mutating result remains UNKNOWN; no automatic retry. Owner service supplies durable reconciliation/receipt.

**Overall CR-09 remains OPEN/BLOCKING.** This review accepts only limited reference dispatch behavior. It does not accept Common Envelope v1.0.0 globally, any Control HTTP route, remote authentication, digest profile, stable error map, public route registry, live MCP integration or production readiness.
