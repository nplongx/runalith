# WS2 consumer review V4 — WS8 latest Gateway reference dispatcher / CR-09

**Disposition:** `ACCEPTED_WITH_BLOCKERS_FOR_REFERENCE_DISPATCH_SEMANTICS_ONLY; DRAFT_NOT_RATIFIED`  
**Dispatcher:** `08-gateway-dispatch.rs`, SHA-256 `ee212f9828258fc82804cfbb8c2ce96ae5679df359285bbbd57752b700e9768b`  
**Node/Rust differential:** `b07f13204f2d21f47cb1081395f479ceeb6e73945e768b2c29cf91b3ace3adc1`  
**Probe:** `a59adf2d9bad7704aa9e8b669c88ad9d2a968b10cd3573e443d657655ed182cd`  
**Reconciliation:** `ba6daf85840414ebeca4e7e730fef6e67d0768e7928d357e903de7145a1bbe1d`

## 1. Independent test execution

WS2 independently compiled/reran the exact current WS8 reference source:

`rustc --edition=2021 --test -D warnings rust/workstreams/08-gateway-dispatch.rs -o <temp>/gateway-dispatch-tests && <temp>/gateway-dispatch-tests`

Result: **41 passed, 0 failed**. Probe + Node test: **5/5 PASS**. Temporary files were removed. No WS8 source changed.

Superseded: dispatcher `a8aa1743...`/31 tests and `2bf146e2...`/33 tests; reconciliation `2cb106c9...` and older hashes. Current identity is `ee212f...` and `ba6daf...`.

## 2. Bounded behaviors accepted with blockers

1. Supported version checked before auth, route or service.
2. Principal comes from injected host transport; envelope cannot self-assert identity.
3. Audience, capability and effect are route-derived.
4. Exact producer payload bytes reach injected digest verifier; Gateway does not reserialize payload to manufacture digest.
5. Mutating message requires idempotency key and forwards exact producer key unchanged.
6. Outer message replay identity remains distinct from producer idempotency; exact duplicate replays original reply; changed digest conflicts; cached replay re-verifies bytes.
7. Ordering continuity delegates to owning service.
8. Ambiguous mutation, timeout, invalid response binding, oversized response or replay-receipt persistence fault becomes UNKNOWN/no auto-retry.
9. Producer `domain_code` and `cause_code` remain separate and preserved through UNKNOWN service outcomes.
10. Successful response binding checked against exact request message ID, correlation/version and authenticated route service.
11. MCP JSON-RPC ID helper preserves string/null/number identity including number lexeme through envelope causation/correlation.
12. Route request/response byte caps and deadline budget are validated and forwarded.

## 3. Remaining blockers before wire/runtime acceptance

- `MessageReplayPort` and `PayloadDigestVerifier` are injected ports; tests use in-memory/mock implementations. Production durable replay, crash recovery and cryptographic verifier remain absent.
- MCP JSON-RPC link helpers are tested in reference code but not called by live `runalith-mcp` parser/response serializer.
- `Route` has request/response limits and deadline but is not a complete approved route registry with stable route ID, request/response schema IDs and version ranges, idempotency policy, error-map version and compatibility window.
- Deadline is propagated/checked, but synchronous reference cannot forcibly cancel a blocked service; production cancellation and reconciliation are unproven.
- Dispatcher is not imported by live `runalith-mcp`/`runalith-protocol`; no authenticated remote route or three-deployable integration proven.
- Common Envelope v1.0.0 stays DRAFT/NOT RATIFIED; WS8 owner and Execution-host authority remain unassigned.

## 4. W2 producer mapping constraints

- Outer `message_id` is not inner W2 `renewal_id`, Control fence reservation idempotency key, event ID or provider idempotency key. Approved route mapping must preserve identities.
- Outer `payload_digest` is not W2 `request_sha256`, `acl_sha256`, `event_sha256`, `outcome_sha256`, `completion_sha256`, W4 `payload_sha256` or `request_binding_sha256` unless an approved profile proves exact same bytes.
- Distinct outer message IDs with the same producer idempotency identity must not create duplicate effects; owning service enforces domain idempotency.
- `ordering` mapping remains: stream ID = workflow ID; sequence = committed event sequence; predecessor = immediate prior event ID, not previous hash. Owning service checks continuity; absent/unverifiable history stays UNKNOWN/UNRESOLVED.
- Ambiguous mutation remains UNKNOWN; no automatic retry. Owning service reconciles exact durable state/receipt.

**Overall CR-09 remains OPEN/BLOCKING.** This review accepts limited reference semantics only. It does not approve public Control routes, remote authentication, production digest/replay services, complete route registry, live MCP wiring, Common Envelope ratification or release readiness.
