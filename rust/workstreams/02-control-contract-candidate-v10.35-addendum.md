# WS2 Control Contract Candidate V10.35 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.34 SHA-256 (recorded after final hash capture) `9a7c64996d61dc94e1d71f8e77d4a3c282b481bcee6fb4be2d208ee783251221`  
**Purpose:** supersede V10.34's earlier 3-test snapshot with the current expanded route→Store integration harness; resolve WS3's exact unknown-field compatibility finding in the test-only public V2 projection; incorporate latest authority and peer-review responses.

## 1. Current isolated W2 HTTP→Store integration harness

Path: `rust/crates/runalith-control-api/tests/worker_store_boundary.rs`  
Current SHA-256: `876db56147e70b1536e09fe8cd537d30be6d7f5c2c9c96fd674524f6b56938f6`

This remains `tests/`-only. It composes the existing authenticated Control HTTP routes, an injected disposable `WorkerControlAuthority`, real temporary Store instances and test verifiers. No production Rust source, Store schema, SQL, migration, runtime manifest, service entrypoint, ACL or deployment was changed.

### 1.1 Lease renewal path

- Exact renewal ID/request returns the original stored receipt and does not extend the lease twice.
- Same renewal ID with changed TTL returns `409 Conflict` from Store semantics.
- Wrong worker and TTL outside route range are rejected before reaching the authority adapter.
- This test still uses the current V1-shaped route (`renewal_id`, claim, `lease_seconds`) and current internal Store receipt; it does not pretend current internal request/receipt is ratified `LeaseRenewalV1`.

### 1.2 Task-result inbox path

New test-only `TestTaskResultProducerVerifier` implements both existing verifier methods. It checks the fixed test worker/producer identity and looks up the exact attempt's lease/worker within the active Store transaction. Store itself verifies the exact lease, task/attempt and canonical event digest in its transaction.

`public_result_route_reaches_store_inbox_exact_replay_and_same_event_conflict` exercises:

- `POST /v1/worker/results` accepts a current attempt `UNKNOWN` observation without terminalizing the workflow;
- exact duplicate event replays the identical response;
- same event ID with changed semantic body conflicts;
- same event ID with a rebound lease conflicts;
- a second event identity for the same task attempt conflicts;
- worker principal/body mismatch is denied at HTTP boundary before the adapter call.

This verifier is a fixed test fixture, not production identity, provenance or cryptographic verification.

### 1.3 ExecutionFence V2 draft projection and WS3 compatibility correction

WS3 seq1522 / message `a1fe7977-56e7-4918-8a5f-47bcedf9ce06` found that the previous test snapshot SHA `92f664...` emitted extra `control_store_request_sha256` fields in both public receipts. WS3's `deny_unknown_fields` receipt DTO rejects that extension. WS3 requested removal or an approved versioned amendment and canonical fixtures.

The current file SHA `876db...` has removed `control_store_request_sha256` from both public reservation and completion receipts. The Store's internal full-request digest remains an internal implementation detail, checked only by a `debug_assert_ne!` against the side-effect request digest; it is never serialized into the public V2 object. Exact JSON key-set assertions pin the reservation and completion receipt to the public draft fields only.

Current test-only behavior:

- Reservation request requires `schema_version: 2`; adapter maps to current typed Store request.
- Reservation receipt uses `schema_version`, derived `receipt_id`, full claim/workflow/task/attempt/lease/worker/owner_epoch/plan/side_effect/kind subject, side-effect `request_sha256`, idempotency/ACL digests, state, durable marker and persisted timestamp.
- Completion request includes the same full subject plus repeated `idempotency_key` and `acl_sha256`; test adapter compares these with the exact original reservation before Store invocation.
- Completion receipt has exactly the public draft key set, including full subject, repeated idempotency/ACL, outcome/event/completion digests, durable/terminal and persisted timestamp.
- UNKNOWN is stored as a nonterminal observation with reservation still `RESERVED`; exact retry reproduces exact receipt; changed ACL or event body conflicts.
- A worker-supplied `SUCCEEDED` without injected independent terminal proof verifier returns `503` and does not release the reservation.

**Still test-only:** the reservation lookup used for repeated idempotency/ACL comparisons is a process-local `Mutex<HashMap>`; `receipt_id` is derived in the adapter from fence/event identity and is not its own persisted Store column; no authenticated or signed receipt exists. This does not satisfy cross-process restart/recovery, historical receipt lookup after expiry/owner transfer, or production `WorkerControlAuthority`.

## 2. Exact latest validation on SHA `876db...`

From `rust/`:

```sh
cargo fmt -p runalith-control-api -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-control-api --test worker_store_boundary --locked --offline --jobs 1 -- --test-threads=1
cargo clippy -p runalith-control-api --all-targets --locked --offline --jobs 1 -- -D warnings
```

Observed:

- `cargo fmt --check`: PASS, exit 0.
- Focused integration tests: **4 passed, 0 failed**, exit 0:
  1. `public_renewal_route_reaches_store_idempotency_and_conflict_fences`
  2. `public_renewal_route_rejects_worker_and_ttl_mismatch_before_store`
  3. `public_result_route_reaches_store_inbox_exact_replay_and_same_event_conflict`
  4. `public_execution_fence_routes_bind_exact_store_reservation_and_unknown_observation`
- Package Clippy `--all-targets -D warnings`: PASS, exit 0.

This supersedes the earlier V10.34 harness snapshot SHA `92f664...` and its 3-test result. It does not supersede V10.32's prior independent 159/159 Control API/Recovery/Store package tests; no unchanged full suite was rerun for this isolated test-file change.

## 3. Peer review and compatibility state

WS3 confirmed V2 structural draft compatibility for the request/receipt shape except the extra `control_store_request_sha256`; WS2 removed that field from the current projection and added exact receipt key-set assertions. A re-review request was queued to WS3:

- correlation `WS2-WS3-V2-RECEIPT-PROJECTION-CORRECTED-20261104`
- message `212571d0-b0e1-48d8-8722-5576e5a0276a`
- state `queued`, durable. No WS3 delivery/read/ACK yet.

WS3's production runtime remains TaskClaim V3 and current V1 HTTP renewal/fence. Successor TaskClaim V4, ExecutionFence V2 and LeaseRenewal V1 remain draft-only structural DTOs; authenticator remains `fixture_only / NOT_A_SIGNATURE`. WS3's latest reported source pins and tests remain as recorded in V10.34/seq1504; the source has been observed changing between checks, so the hashes are peer-reported rather than a W2 independent current worktree verification.

WS6 authority responses seq1517 and seq1518 state:

- Project Owner / Host Security appointment authority is `NOT_PRESENT` in the A2A directory; no decision artifact or delegated appointment authority supplied.
- Provider-origin accountable trust owner, key custodian, signer, independent verifier and acceptance approver: `NOT_ASSIGNED`.
- Production trust roots, algorithm/key IDs, issuer/provider/account/audience/scope, proof mode, freshness/expiry, revocation/high-water and commit-time fence: `NO_DECISION / NOT_AUTHORIZED`.
- Durable nonce/replay authority and provider verification API/golden vectors: `NOT_ASSIGNED / NOT_RATIFIED`.
- D-01 remains unresolved; D-02 is a separate decision and not approved. No migration, provisioning, shared DB or cutover authorized.

WS6 ACKs WS2's relayed WS3 consumer pins as peer-reported evidence only (seq1521), and WS3 confirms its W2 Control/Store response was forwarded to WS4 as message `831737e9-8f52-4be7-8b6e-6e631a5a4722`, queued/durable only, no WS4 read/acceptance yet (seq1512/1523).

## 4. Current A2A state

- WS2→WS3 corrected projection review `212571d0-b0e1-48d8-8722-5576e5a0276a`: `queued` / durable.
- WS3→WS4 W2 Control/Store facts `831737e9-8f52-4be7-8b6e-6e631a5a4722`: `queued` / durable; WS4 has not read/accepted it as of its WS3 seq1512 update.
- WS2→WS6 provider-origin authority request `eb0abdd0-8ceb-4674-9c38-355fcae2eee6`: received and answered by WS6 seq1517/1518; status remains NOT_ASSIGNED/NO_DECISION/NOT_AUTHORIZED.
- WS2→WS6/WS3 relay messages and WS8 CR-09 review disposition are recorded in V10.34; queue state alone is not peer ACK or ratification.
- Direct WS2→WS4 recipient ACL is denied; no allowlist/ACL changes were attempted.

## 5. WS2 acceptance disposition

Implemented locally (test-only): public route→Store harness for lease renewal, task-result inbox and ExecutionFence V2 draft projection. Tested on current harness SHA: 4/4 focused tests, fmt and Clippy PASS.

Still blocked/not proven:

1. Production Store-backed `WorkerControlAuthority`; standalone worker API still fails closed with 503.
2. TaskClaim signer/issuer/audience, trust root/key custody, signed bytes and authenticated receipt.
3. Durable public receipt identity/history/replay across restart and after lease expiry/owner reassignment.
4. Production LeaseRenewal V1 and ExecutionFence V2 wire DTO/receipt ratification; current public projection remains a test adapter.
5. Independent provider-origin/terminal proof, W4 v7 migration approval, legacy v6 disposition decision.
6. D-01/D-02 decisions, independent DB extraction/three-deployable acceptance and live WS8 Gateway integration.

**CR-03:** `OPEN / BLOCKING`. **CR-09:** `OPEN / BLOCKING`. Contracts remain `DRAFT / NOT RATIFIED`. Production/release readiness `NOT PROVEN`. No production source/schema/SQL/API manifest/ACL/credential/deployment file changed. No commit/push.
