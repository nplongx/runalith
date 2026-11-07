# WS2 Control Contract Candidate V10.34 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.33 SHA-256 `bdb2f9b57830afbd2812bc44b3c445ffa9a6fea7f8d692df7b69a274da7b2e19`  
**Purpose:** record the new isolated HTTP-route→Store integration test and the latest WS3/WS6/WS8 coordination evidence. This does not add production authority or change the three-deployable boundary.

## 1. New isolated WS2 integration slice

New file: `rust/crates/runalith-control-api/tests/worker_store_boundary.rs`  
SHA-256: `92f66489134065152cb623b753141bc5fd1b3a7fc381aedc072a71fdeceef7a8`

This is integration-test-only code. It composes `ControlApi::from_store` with a test `WorkerControlAuthority`, an authenticated test principal, a temporary Store database and a test-only approval verifier. It does not edit `runalith-control-api/src`, `runalith-store/src`, runtime source, schemas, migrations, manifests or deployments.

The test adapter now presents the proposed V2 shape at the public `WorkerControlAuthority` port and translates to the existing typed Store DTOs:

- Reservation request requires `schema_version: 2`; Store persists the typed request and event in its existing immediate transaction.
- Reservation receipt projection includes `schema_version`, a deterministic derived `receipt_id`, full claim/workflow/task/attempt/lease/worker/epoch/plan/side-effect subject, `request_sha256`, `idempotency_key`, `acl_sha256`, state, durable marker and timestamp.
- `request_sha256` remains the side-effect request digest. Store's internal `record.receipt.request_sha256` hashes the complete `WorkerExecutionFenceRequest`; the test projection exposes it separately as `control_store_request_sha256`. The two are asserted different.
- Completion request requires `schema_version: 2` and repeated `idempotency_key`/`acl_sha256`; the harness compares both against the original reservation before passing the Store completion DTO. Changed bindings conflict.
- Completion receipt projection contains the complete repeated subject, event/outcome/completion digests, stable derived observation `receipt_id`, durable/terminal flags and persisted timestamp.
- UNKNOWN observation is durably recorded while fence remains RESERVED; exact retry returns byte-equivalent JSON; changed body under the same event identity conflicts; worker-supplied SUCCEEDED without an injected proof verifier returns 503 and does not release the reservation.
- Lease-renewal route reaches Store `renew_task_lease`; exact renewal ID/body returns original expiry; same ID with changed TTL conflicts. Wrong worker identity and unsupported TTL fail before the Store method.

### Exact focused verification

From `rust/`:

```sh
rustfmt --edition 2024 crates/runalith-control-api/tests/worker_store_boundary.rs
cargo fmt -p runalith-control-api -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-control-api --test worker_store_boundary --locked --offline --jobs 1 -- --test-threads=1
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy -p runalith-control-api --test worker_store_boundary --locked --offline --jobs 1 -- -D warnings
```

Observed: **3/3 integration tests PASS**, `cargo fmt --check` PASS, focused Clippy `-D warnings` PASS, all exit 0. Tests:

1. `public_renewal_route_reaches_store_idempotency_and_conflict_fences`
2. `public_renewal_route_rejects_worker_and_ttl_mismatch_before_store`
3. `public_execution_fence_routes_bind_exact_store_reservation_and_unknown_observation`

The three existing unit/process suites were previously verified in V10.32 (Control API/Recovery/Store 159/159); they were not rerun because this slice changes only the new integration-test file.

### Boundaries — still not a production adapter

The adapter exists only under `tests/`. Its repeated idempotency/ACL comparison uses a process-local `Mutex<HashMap<...>>`; that is intentionally insufficient for restart/cross-process receipt validation. `receipt_id` is derived from persisted fence/event identity and is not a separate Store column. No cryptographic receipt/signature, signer, issuer, audience registry, durable nonce, Store-backed production `WorkerControlAuthority`, or live worker HTTP acceptance is created. The standalone `ControlApi::from_store` leaves `worker_control=None`; `/v1/worker/*` continues to fail closed with 503. No historical reservation receipt lookup after lease expiry/owner transfer was added.

The current Store `TaskLeaseRenewalRequest` still has no `claim_id`, `schema_version`, independent `receipt_id` or authenticator. Store reservation/completion DTOs remain unversioned internal types; completion DTO itself does not repeat `idempotency_key`/`acl_sha256`. The test projection detects this mismatch; it does not silently claim the test map is a durable producer contract. The public LeaseRenewalV1 and ExecutionFenceV2 DTO/receipt mapping is still proposed, not ratified.

## 2. WS3 consumer contract and exact status

WS3 A2A seq1504 / message `425e2fb9-55c9-493e-953a-a36bb2a7a171` reports:

- Active production worker runtime remains TaskClaim V3 and current V1 HTTP renewal/fence DTOs.
- TaskClaim V4, ExecutionFence V2 and LeaseRenewal V1 successor DTOs remain draft-only structural consumers.
- TaskClaim authenticator remains `fixture_only / NOT_A_SIGNATURE`; no signed-byte profile or production issuer/verifier is established.
- WS3-reported current pins: `main.rs` `c0075936f7d09d9ec63a6bd7d0c07d440c7718171060b68f66204914203fa94f`; `config.rs` `e40c9c44acd6c10d19ef66c2210bd1e2a6a4cf2b73db956dda013f4cd2b5c273`; `control_http.rs` `6dc1340ec8cfa3c89486c5335fdf40006e230b43c9c6d34218009a9249a929c3`; `supervisor.rs` `5a1bd3b87d3ed6f70887bba5b3024c594368d427333a00a41dcd1276dac12ab2`; `lib.rs` `f1fb8b16b83bc8562cf75151661e35145cb6e7688e60cc6e499595d5cd623ca8`; `draft_contracts.rs` `2ae9c276aef1f8ed48c6870c9857e5bd5a5351a259c648396f285412872eaf18`.
- WS3 reports binary 24 passed +1 ignored (separate cross-UID regression 1/1), config 2/2, draft contracts 13/13, prepared renewal 1/1, restart replay 1/1, Node V1 parity 3/3; fmt/Clippy/build PASS.

Those source hashes/results are peer-reported in A2A, not independently rerun by WS2. WS2 observed source churn during hash checks before the seq1504 confirmation; use only the seq1504 pins as WS3's latest reported candidate and do not treat any older `bfb...`, `c2f3...`, `75091...` or `d66...` `main.rs` pin as current. WS3 ownership/worktree remains isolated/unmerged.

WS3 previously requested a complete public V2 receipt adapter. The new WS2 test projection now covers the proposed full subject, distinct digest names and repeated completion bindings at the HTTP port. It does **not** satisfy durable restart lookup, independently authenticated receipt, or a production authority; WS3 review of the exact test file/hash remains pending.

## 3. WS8 CR-09 review status

WS2 re-reviewed WS8 dispatcher SHA `ee212f9828258fc82804cfbb8c2ce96ae5679df359285bbbd57752b700e9768b`; the prior exact run remains 41/41 Rust +5/5 Node/Rust. Review V4 SHA `4ff12ddd714119db238f6dd44d804d0601a6fe275128b7a7ea2f8308c25895d3` records accepted reference semantics and remaining blockers. WS2 sent a new review disposition message `dc69ae5c-6ed8-4019-8d1f-4bef13a4c0fe` (`queued`, durable); no peer ACK/receipt yet. CR-09 remains OPEN/BLOCKING.

## 4. A2A coordination evidence

WS2 endpoint `437be3a9-103a-4a76-b214-a5925207df30` and WS1 endpoint are active; peer directory listed WS3, WS4, WS6 and WS8 active. Recipient endpoint ACL prevented direct WS2→WS4 send (`Sender endpoint is not authorized by recipient endpoint ACL`); no ACL was widened.

New outbound messages observed as queued/durable (not received or accepted):

- WS2→WS6 provider-origin authority relay: `eb0abdd0-8ceb-4674-9c38-355fcae2eee6`.
- WS2→WS3 consumer review relay: `ef817485-8213-4683-bccd-abf31ec4a95a`.
- WS2→WS6 WS3 source/test-pin relay: `3a71634d-2962-45cb-b1eb-ac6ff1ea5dcb`.
- WS2→WS6 delivery-status update: `6542fe5e-09b0-41c4-8635-a0a5f61b89fb`.
- WS2→WS3 W2 Control/Store response for onward WS4 relay: `843c8474-5db4-4d15-9fd0-4162164c1df0`.
- WS2→WS8 CR-09 review V4 disposition: `dc69ae5c-6ed8-4019-8d1f-4bef13a4c0fe`.
- Earlier WS6 trust status remains `NOT_ASSIGNED / NO_DECISION / NOT_AUTHORIZED / BLOCKED` (A2A seq1435/1436); D-01 unresolved and D-02 not approved. WS4 v7 migration not authorized.

WS6/WS3 inbound messages through seq1504 were read; ACK calls succeeded for messages `789a922e...`, `4f1d785a...`, `35665626...`, `ee0e077d...`, `371db173...`, `595b6f0e...`, `0c5c4b38...`, `97f2b246...`, `1cb163c4...` and `425e2fb9...`. Three ACK attempts for seq1431/1436/1487 were blocked by host safety checks; do not claim acknowledged. Peer send queue status is not evidence of recipient delivery/read.

## 5. WS2 acceptance disposition

- Implemented in this slice: isolated public-route→Store integration harness; explicit V2 test projection; negative binding tests; exact focused integration validation.
- Tested: 3/3 new integration cases; formatting and focused Clippy PASS.
- Existing W2 evidence: V10.32 records Control API/Recovery/Store 159/159 + fmt/Clippy; V10.33 records WS6 Trust 87/87 + fmt/Clippy. No unchanged full suite rerun here.
- Still blocked: production Store-backed `WorkerControlAuthority`, TaskClaim signing/issuer/audience authority, durable authenticated receipt, public V1 renewal claim_id/receipt_id/history lookup, public V2 fence receipt persistence/authentication, historical reservation lookup after expiry/reassignment, independent provider terminal proof, D-01/D-02, WS4 migration and live WS8 integration.

**CR-03:** OPEN / BLOCKING. **CR-09:** OPEN / BLOCKING. All public cross-part DTOs remain DRAFT / NOT RATIFIED. Production/release readiness NOT PROVEN. No production source, Store schema, SQL, migration, API manifest, ACL, credentials or deployment changed. WS2 HEAD unchanged; all new artifacts remain untracked; no commit/push.
