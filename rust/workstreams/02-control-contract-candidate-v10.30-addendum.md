# WS2 Control Contract Candidate V10.30 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.29 SHA-256 `eb09c7a4ac26748722c07fca38164c6c2eef22ffabb84e450c34e9abda7290fe`  
**Purpose:** answer WS3's relayed WS4/WS6 ExecutionFenceV2 + provider-v7 questions with exact current WS2 Store behavior, distinguish implementation from draft vectors, and record latest WS8 reference-dispatch consumer review.

## 1. WS3 / WS4 ExecutionFenceV2 request — WS2 producer disposition

WS3 relayed WS4 source message `d88a3881-302a-41ea-9d1a-7cd519469282` in WS3 A2A seq1379; WS2 acknowledged WS3 message `decd9bbb-8795-427d-9c65-1b458fe4c23c` and relayed the authority questions to WS6 through the permitted WS2→WS6 channel. WS2 relay message `9f1aaa7d-13c1-4ae6-9725-7f595263397e` is queued/durable. No Project/Host authority approval is inferred.

### 1.1 Current Store producer subject already contains first-class attempt

Current W2 Store source: `rust/crates/runalith-store/src/lib.rs`, SHA-256 `a08e43b192d02666f8b5956fa8122bd6acaf996524160c4414d5870e49ffe3e3`.

`WorkerExecutionFenceRequest` (source around lines 868–900) contains:

`claim_id, workflow_id, task_id, attempt, lease_id, worker_id, owner_epoch, plan_sha256, side_effect_id, kind, request_sha256, idempotency_key, acl_sha256`.

`WorkerExecutionFenceCompletion` (lines 905–938) repeats the same subject fields, adds `fence_id`, and carries `outcome, event_id, event_sha256, outcome_sha256`.

The typed request/completion structs do **not** currently carry `schema_version=2`. The WS2 V2 fixture's `schema_version=2` is a proposed wire wrapper; current typed Store DTO is unversioned/internal. Do not claim the public `ExecutionFenceV2` endpoint is implemented.

The `worker_execution_fences` table (DDL around lines 7944–8000) persists claim/workflow/task/attempt/epoch/lease/worker/plan/side-effect/kind/request digest/reservation idempotency key/ACL digest. Constraints include:

- `idempotency_key TEXT NOT NULL UNIQUE`;
- `UNIQUE(workflow_id,task_id,attempt,owner_epoch,kind,side_effect_id)`;
- FK to exact `task_attempts(workflow_id,task_id,attempt)`;
- insert trigger requires current RUNNING task, exact attempt/epoch/lease/worker, matching plan, and a lease expiry greater than current time;
- update trigger permits only one transition `RESERVED -> COMPLETED` while all immutable identity fields stay equal;
- no-delete trigger.

Thus the first-class Control attempt/epoch and side-effect uniqueness are implemented in the local Store transaction, not merely present in a fixture.

### 1.2 Request digest and idempotency domains

W2's `WorkerExecutionFenceRequest.request_sha256` is the exact side-effect request digest. For provider dispatch, WS2's V2.1 crosswalk defines it equal to W4 `request_binding_sha256`, not W4 `payload_sha256` and not W8's outer envelope `payload_digest`. WS2 V2.1 fixture/validator hashes:

- V2.1 note `02-control-worker-boundary-v2.1.md`: `4e563b01da1658a26acb58ed2426efffa70ccde9405b43c671fd3ae4a8140c19`.
- V2.1 fixture: `4c2b29f378b06cba0bfeca3ed60a6614e2a39be18f94ee5d2c03c5578a22dfbb`.
- V2.1 validator: `b679503a74c4729a7c61ed516841f2146d83a82ad9ca66abe4c0ae5f02c3cc87`.
- `python3 -B rust/workstreams/02-control-worker-boundary-v2.1-test.py` — PASS, 32 structural negative mutations. Four authority/crypto/compatibility/settlement groups explicitly remain NOT RUN.

The domains remain distinct:

1. W4 provider-side idempotency key (unique per provider identity, documented by WS4 as `(provider_id,idempotency_key)`).
2. W2 Control fence reservation `idempotency_key` (unique in `worker_execution_fences`).
3. W2 side-effect identity tuple `(workflow_id,task_id,attempt,owner_epoch,kind,side_effect_id)`.
4. W4 `request_binding_sha256` / W2 `request_sha256` (immutable side-effect subject digest).
5. W4 `payload_sha256` (provider payload only).
6. W8 outer payload digest (outer envelope payload bytes).
7. W2 journal event hash and completion/observation digest.

A single identity/digest must never be substituted for another. The V2.1 fixture crosswalk is a historical source snapshot: it pins the then-reviewed WS4 proposal SHA `f61746825ef15937e33916640a370edad662ebc39cbcae4350abb5cba8951d9b`. Current WS4 proposal bytes have since changed; current proposal SHA is `7bf89164680ebb9fc693711bb431b60984b9829a73037d74c268391914062ade`. V2.1 remains a fixture-level check, not a live hash pin for the newer proposal. Current WS4 candidate's own test suite was independently run in its isolated worktree; see §1.6.

### 1.3 Reservation CAS/replay — exact behavior and limit

`Store::reserve_worker_execution_fence` (source lines 5059–5145):

1. Validate all subject identifiers, positive attempt/epoch and lower-case digest fields.
2. Open SQLite `IMMEDIATE` transaction; fail closed if Store quarantined.
3. Call `verify_current_execution_fence_owner` **before** duplicate lookup. Requires current task `RUNNING`, exact attempt/epoch/lease/worker/plan and unexpired lease.
4. Look up existing reservation by unique Control fence idempotency key. Exact request returns the stored `WorkerExecutionFenceRecord`; changed subject/request under same key returns `WorkerExecutionFenceConflict`.
5. Enforce unique natural side-effect tuple `(workflow,task,attempt,epoch,kind,side_effect_id)`; same side effect under a different Control reservation key conflicts.
6. Insert immutable fence row and `worker.execution_fence_reserved` event in the same transaction; commit and return record.

**Important replay boundary:** reservation replay is not an unconditional historical receipt lookup. Because current live-owner validation precedes duplicate lookup, exact reservation replay after lease expiry, task terminalization, owner transfer or quarantine is rejected/fenced. This preserves no-resurrection semantics. The Store cannot replay a historical reservation receipt without a current valid claim/lease.

### 1.4 Completion/observation receipt replay — historical exact replay is implemented

`complete_worker_execution_fence_inner` (source lines 5181–5463):

- Verify every subject field in completion against the stored reservation, including first-class attempt, owner epoch, lease, worker, plan, side-effect ID/kind and request digest.
- Deduplicate observation by `worker.execution_fence.observation:{fence_id}:{event_id}`.
- On duplicate, validate the full workflow event hash chain, parse the stored completion, compare exact completion bytes/fields, recompute `completion_sha256`, reconstruct and compare the exact durable receipt/payload, and check projection consistency. Exact match returns the original stored observation receipt; changed completion under the same event identity conflicts.
- This lookup happens before current task state/owner checks, so an exact historical observation receipt remains replayable after later terminalization/reconciliation, provided its event chain and stored projection still validate.
- First-time completion verifies historical owner from `task_attempts`; provider dispatch may be reconciled late after local task `SUCCEEDED`/`FAILED` only for the same attempt and owner epoch. Other fence kinds (especially `sandbox_start`) cannot use that late path.
- `SUCCEEDED`/`FAILED` requires a host-injected `WorkerExecutionFenceCompletionVerifier` inside the Store transaction. `UNKNOWN` remains nonterminal/RESERVED. `NOT_STARTED` is terminal only when the verifier independently proves no side effect began; without verifier it remains nonterminal.
- Terminal transition and observation event are committed atomically. An observation receipt is not proof that the provider originated the bytes.

**Reservation replay and completion receipt replay are therefore different contracts.** Historical completion observation replay is implemented; historical reservation replay after current lease expiry is intentionally not.

### 1.5 Internal Store receipt is not yet the proposed public V2 receipt

Current `WorkerExecutionFenceRecord` is `{fence_id, request, state, completion, completion_sha256, receipt, created_at, completed_at}`. Current reservation `receipt` JSON generated around lines 5103–5112 has only:

`type=worker_execution_fence_reservation, fence_id, request_sha256, durable, recorded_at`.

The `request_sha256` value inside that metadata object is currently computed as `content_hash(&request)` over the complete `WorkerExecutionFenceRequest`. It is **not** the same field as `request.request_sha256` (the side-effect/W4 request-binding digest). Do not map this metadata key directly to the V2 subject's `request_sha256` without an explicit versioned rename/field definition.

The current Store reservation receipt does not contain `schema_version`, `receipt_id`, or the full echoed subject. `WorkerExecutionFenceRecord.request` carries the subject separately. Current completion observation receipt contains fence/event/outcome/completion digest, durable/time/terminal, but likewise no cryptographic issuer/signature. Therefore an HTTP/WS3 `ExecutionFenceV2` adapter must explicitly assemble a public DTO from the typed record and observation result, define distinct `receipt_id` and reservation-request digest names, and bind issuer/audience/signature via an appointed authority. No such public adapter is claimed implemented.

### 1.6 Targeted Store and WS4 candidate tests

WS2 ran each Store regression below; every test passed 1/1:

- `worker_execution_fence_is_transactional_idempotent_and_finalized_once`.
- `execution_fence_unknown_observation_receipt_survives_store_restart_and_terminal_reconciliation`.
- `not_started_execution_fence_releases_only_after_independent_proof_verification`.
- `concurrent_identical_execution_fence_reservation_and_completion_share_receipts`.
- `provider_fence_can_finish_after_task_result_but_sandbox_fence_cannot`.
- `event_chain_detects_tampering_even_if_append_only_trigger_is_bypassed`.

WS2 also reran `02-control-worker-boundary-v2-test.py` and V2.1 validator; both passed. V2 validator reports 26 structural negative mutations PASS with four NOT RUN groups; V2.1 adds the six typed command negatives for 32 PASS; neither executes Store, HTTP, signer, WorkerStore, provider dispatch or settlement.

WS4 current isolated worktree: `/home/long/work/chatgpt-adapter-ws4-20261103`, HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`, `rust/` remains untracked/unmerged. Current hashes:

- Proposal `04-provider-effects-v2-proposal.md`: `7bf89164680ebb9fc693711bb431b60984b9829a73037d74c268391914062ade`.
- Persistence ADR: `28f381611d0e12a73d1034e82105f265e2cce034e5480b46c0c2ccb1386b50c9`.
- Schema: `fe6d7aa1dd1cfc4aab98964a49ce9894d28ca321666deca6209e448bd8a2a778`.
- Example: `1924d147b9826075fbaf8070417a29c9a05730b52ab12f6cd41919b37a5bb623`.
- Python validator: `1c16a6da184bd314f3199ad4a762ca81188197cff1fc91d259fdc9834a0cebe2`.
- Canonical vectors: `0814f1276eb9b61d7437bb74b45d75250339e89f5acb9335099ac002abe09239`.
- Persistence source v6: `fac480681c9b0f960671264521fca9dc271591fcea887842d8971576698badc5`.
- Draft V2 DTO validator: `f51ad55669286db7fba8cd2c2f23f6b59a8df7967f9fcd4dc2bd64354e4164f5`.

WS2 independently ran current WS4 local candidate commands; all passed:

- `python3 -B workstreams/04-provider-effects-v2-test.py`: 6/6 fixture groups.
- `python3 -B workstreams/04-provider-effects-v2-ws6-proof-boundary-test.py`: 4/4 fail-closed checks.
- `node workstreams/04-provider-effects-v2-canonical-node-test.js`: 5/5 cross-language vectors.
- `cargo test -p runalith-providers --locked --offline --test provider_effects_v2_golden`: 3/3.
- `cargo test -p runalith-providers --locked --offline --test provider_effects_v2_canonical`: 1/1.
- `cargo test -p runalith-execution-persistence --locked --offline schema_v6_restart_preserves_attempt_but_has_no_provider_account_binding`: 1/1.

These validate WS4 candidate DTO/digest and v6 identity-gap evidence. They do not implement or approve migration, Control receipt authentication or provider origin proof.

## 2. W4 v6→v7 provider-account columns and legacy policy — W2 disposition

The four requested persistence columns belong to WS4's `provider_dispatch_intents` table, not W2's `worker_execution_fences` table:

- `provider_account_id`;
- `provider_account_config_version`;
- `provider_account_config_sha256`;
- `request_binding_sha256`.

W2's current Control fence binds the W4 immutable provider subject digest through `WorkerExecutionFenceRequest.request_sha256`. W2 does not store W4's account/config snapshot as separate columns and has no basis to approve/reject W4-owned DDL/trigger or v6→v7 rollout.

WS4 ADR SHA `28f381611d0e12a73d1034e82105f265e2cce034e5480b46c0c2ccb1386b50c9` proposes the four columns nullable for historical v6 rows and required on every new V2 v7 insert; it keeps legacy `request_sha256=sha256_json(payload_json)` as payload digest, distinct from new `request_binding_sha256`. Its fail-closed recovery matrix says:

- nonterminal v6 rows without account binding remain unchanged and `UNRESOLVED`/quarantined; no dispatch, provider lookup, automatic replay or ambient-config inference;
- v6 `UNKNOWN` remains `UNKNOWN` and is not queried against a current/default account;
- terminal v6 history remains auditable but receives no inferred account attribution or V2/VERIFIED upgrade;
- any approved external recovery is separate append-only audited work, not in-place backfill.

**WS2 disposition:** agrees with the no-backfill/no-ambient-account/no-new-dispatch rule as a safety requirement. This agreement is not Project/WS4 owner approval for DDL, trigger, schema v7, mixed-version rollout or migration. Those remain `NOT APPROVED / NOT AUTHORIZED`; named Project/W4 owner and written authority decision are absent.

## 3. WS6 authority relay state

WS2 sent WS3's WS4/WS6 request through the allowed WS2→WS6 dependency edge. Relay message ID `9f1aaa7d-13c1-4ae6-9725-7f595263397e`, correlation `COS-WS2-WS6-WS4-EXECUTION-FENCE-V7-AUTHORITY-RELAY-20261104`, state queued/durable at send. It requests explicit signer/trust root/key custodian, proof mode, issuer/audience/scope, freshness/revocation/high-water, nonce/replay boundary and Project/Host written migration decision. No response/relay receipt has been observed in WS2 inbox through the latest poll. Do not infer WS6 or Project approval.

WS6's prior claim issuer boundary (A2A seq1301) remains: Control/WS2 owns claim issuance; WS3 owns worker audience/consumer; WS6 only owns trust/key profile after Project Owner + Host Security appoint authority. No claim signer, key custodian, issuer identity, audience registry or signing profile is currently assigned.

## 4. WS8 reference dispatcher — CR-09 consumer review update

WS8 message `5350d2ad-f41f-42f1-9f43-360b9c9fca38` reports a new WS8-owned DRAFT reference dispatcher (not imported into live MCP):

- `08-gateway-dispatch.rs` SHA `a8aa17432e7b5ec7aa37dee92b552c4ae3e3ad09eb567f53a93493833be458bb`.
- Node/Rust version probe SHA `a59adf2d9bad7704aa9e8b669c88ad9d2a968b10cd3573e443d657655ed182cd`.
- Node differential SHA `b07f13204f2d21f47cb1081395f479ceeb6e73945e768b2c29cf91b3ace3adc1`.

WS2 independently compiled its exact Rust test module with `rustc --edition=2021 --test -D warnings` and ran it: **31/31 PASS**. WS2 reran Node/Rust version differential: **5/5 PASS**.

Bounded consumer acceptance with blockers:

- supported wire version checked before auth/route/service;
- host transport principal is injected, `producer_id` is authenticated against that context, audience/capability/effect are route-derived;
- digest verifier receives exact producer bytes; Gateway does not normalize/re-serialize payload;
- mutating envelope requires `idempotency_key`, forwarded unchanged to owning service;
- exact duplicate `(message_id,payload_digest)` replays original response; changed digest conflicts;
- ordering continuity delegates to owner service, not Gateway shadow state;
- ambiguous mutation becomes UNKNOWN/no automatic retry;
- stable Gateway category does not rewrite producer `domain_code` or `cause_code`.

Changes still required before CR-09 wire/integration acceptance:

1. `MessageReplayPort` is injected; tests use in-memory/mock ports. Durable/atomic replay store and owner-service reconciliation remain unimplemented. Gateway keys its replay port by envelope `message_id` plus payload digest; distinct `message_id` values sharing one producer `idempotency_key` must be handled by the owning service. Map outer message identity to inner W2 `renewal_id`/fence reservation identity without conflating those domains.
2. `validate_response_binding` is a helper, not invoked by the `dispatch` function shown. Actual response-envelope serialization/validation and MCP JSON-RPC request ID -> envelope `message_id`, response `causation_id`, correlation and idempotency mapping remain to be integrated/tested.
3. Current `Route` only has `message_type,service_id,required_capability,effect,ordering_required`; it lacks route ID, request/response schema IDs/version range, idempotency policy, per-route payload/deadline limits, stable error-map version and compatibility window required by WS8 route registry.
4. Digest verifier is an injected port; no production cryptographic verifier/peer auth or durable signer profile is supplied. 31 tests do not prove remote service identity or actual route.
5. Mutating `ServiceResult::Failed` is safely downgraded to UNKNOWN, but its original service code/message is replaced by a generic UNKNOWN message in that path. WS8 should prove producer domain/cause code is retained separately on ambiguous mutation while preserving UNKNOWN/no-retry semantics.
6. Reference code is not wired into `runalith-mcp`/`runalith-protocol`; no end-to-end route or 3-deployable integration.

**CR-09 disposition:** `ACCEPTED_WITH_BLOCKERS_FOR_REFERENCE_DISPATCH_SEMANTICS_ONLY`. This is not global envelope, route, auth, digest, error-map or live-MCP acceptance. Common Envelope v1.0.0 remains DRAFT/NOT RATIFIED.

## 5. Current task matrix

| Item | Evidence status | Disposition |
|---|---|---|
| WS3 local renewal exact retry/restart consumer | WS3 supervisor/main journal integrated; full 110+3 worker tests, fmt, clippy pass; WS3 ACK seq1377 | `ACCEPTED_WITH_BLOCKERS_FOR_LOCAL_RENEWAL_RETRY_CONSUMER` |
| W2 Store lease renewal | IMMEDIATE transaction, live-owner/attempt/epoch/lease CAS, exact same-ID receipt while current live, changed body conflict, expiry/quarantine fence; six targeted Store tests pass | `IMPLEMENTED_LOCALLY_TESTED; HTTP PRODUCER/STORE ADAPTER BLOCKED` |
| W2 Store ExecutionFence reservation/completion | First-class attempt/epoch subject, unique control idempotency + natural side-effect tuple, reservation CAS, exact completion observation replay and event-chain check; six focused Store tests pass | `IMPLEMENTED_LOCALLY_TESTED; PUBLIC V2 RECEIPT/AUTH ADAPTER BLOCKED` |
| W4 account/config persistence | Draft columns in W4 provider-intent v7 ADR; W4 local validator/canonical tests pass; v6 source proves fields absent | `PROPOSED_NOT_RATIFIED; MIGRATION NOT APPROVED` |
| WS6 provider-origin trust/nonce | WS6 proof mode/authority proposal remains unassigned/no selected root or custodian | `NOT_ASSIGNED / NOT_RATIFIED / BLOCKED` |
| WS8 reference dispatch | 31/31 Rust, 5/5 Node/Rust version probe; reference-only | `ACCEPTED_WITH_BLOCKERS_FOR_REFERENCE_DISPATCH_SEMANTICS_ONLY` |
| Overall CR-03 | consumer retry local pass; W2 HTTP producer adapter/receipt authority and TaskClaim signer unresolved | `OPEN / BLOCKING` |
| Overall CR-09 | bounded mapping/reference dispatch pass with blockers; MCP integration/route/auth/digests/errors unresolved | `OPEN / BLOCKING` |

No production Rust/Node source, API schema, SQL migration, trigger, provider intent table, WorkerStore, Control Store, signer, route or deployment file was changed. WS3/WS4/WS8 candidate trees remain isolated/unmerged; no commit/push. All WS2 evidence remains untracked.
