# WS2 Control Contract Candidate V10.37 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.36 SHA-256 `21ecd1ff9a3241d7c9e7b1ea9789dc5309dbef2dcae189ef69558651eb4c83f1`  
**Purpose:** record WS3's independent acceptance-with-limits of the corrected V2 test projection and its independent rerun of the exact W2 integration target.

## 1. WS3 independent review of current exact W2 test artifact

File: `rust/crates/runalith-control-api/tests/worker_store_boundary.rs`  
SHA-256: `876db56147e70b1536e09fe8cd537d30be6d7f5c2c9c96fd674524f6b56938f6`

WS3 A2A seq1547 / message `2ea9c1f3-be37-48e4-8d7b-941ff16a2e04` disposition:

`ACCEPTED_WITH_LIMITS_FOR_TEST_PROJECTION_ONLY`.

WS3 independently confirms:

- Reservation receipt key set aligns with its flattened `ExecutionFenceV2ReservationReceiptDraft` under `deny_unknown_fields`.
- Completion receipt key set aligns with `ExecutionFenceV2CompletionReceiptDraft` under `deny_unknown_fields`.
- Public `request_sha256` remains the side-effect request digest; the full internal Store DTO hash remains internal.
- The previously identified extra `control_store_request_sha256` property is no longer emitted in this exact file/hash.
- WS3 added `tests/ws2_execution_fence_v2_projection.rs` and reports **3/3 PASS** for exact reservation/completion JSON deserialization, subject/attempt/epoch/idempotency/ACL continuity, rejection of extra `control_store_request_sha256`, changed ACL rejection and UNKNOWN terminal=true rejection.
- WS3 independently ran W2's exact test target:

  `cargo test --locked --offline -p runalith-control-api --test worker_store_boundary -- --test-threads=1`

  Result: **4/4 PASS**, exit 0; `cargo fmt -p runalith-control-api -- --check` and all-target Clippy `-D warnings` PASS.

This independently upgrades the corrected JSON projection's draft-consumer compatibility evidence. It does **not** approve production semantics or ratify V2.

## 2. Limits explicitly retained by WS3

WS3 confirms the adapter remains test-only and identifies the remaining boundaries:

- `reservation_requests` is process-local; it is not durable across restart or independent adapter instances.
- `receipt_id` is derived in test adapter, not backed by an independent persisted receipt ID column.
- No canonical public signed-receipt bytes, issuer authentication, Control signature, production key or verifier.
- No durable public receipt lookup/history API or production `WorkerControlAuthority`.
- Therefore ExecutionFence V2 remains `DRAFT / NOT RATIFIED`; this projection cannot be consumed as production authority.

No production source, Store schema, SQL, migration, manifest, signer, ACL or deployment file was changed by this review.

## 3. A2A delivery / acknowledgement evidence

- WS3 review message: `2ea9c1f3-be37-48e4-8d7b-941ff16a2e04`, seq1547, state `received`; WS2 ACK succeeded at `1793762837`, state `acked`.
- WS2 forwarded the updated authority questions to WS6 as message `c6a434b9-2639-4bd0-8c3e-6e7a3171af02`, correlation `WS2-WS6-V2-REVIEW-AUTHORITY-20261104`, state `queued` / durable. No WS6 response to this latest follow-up is observed yet.
- WS3 previously relayed W2's Control/Store boundary facts to WS4 as `831737e9-8f52-4be7-8b6e-6e631a5a4722`, queued/durable only; no WS4 read/acceptance was reported.
- Direct WS2→WS4 recipient ACL remains denied. No ACL changes were made.

## 4. Authority and release disposition unchanged

WS6 seq1517/1518 still state: Project Owner / Host Security appointment authority `NOT_PRESENT`; provider-origin trust owner, signer, key custodian, independent verifier and approver `NOT_ASSIGNED`; selected proof mode, production roots/issuer/audience, freshness/revocation/high-water and durable nonce/replay `NO_DECISION / NOT_AUTHORIZED / NOT_RATIFIED`.

D-01 remains unresolved; D-02 remains a separate unapproved decision. No database split, migration, provisioning, dispatch, deployment or cutover is authorized. WS4 v7 migration and legacy v6 decision remain owner-gated.

## 5. Current WS2 acceptance disposition

- Test-only Control API→Store route projection: `IMPLEMENTED_IN_TESTS`.
- Focused W2 verification: 4/4 + fmt + all-target Clippy PASS, independently rerun by WS3.
- V2 receipt key-set compatibility: `ACCEPTED_WITH_LIMITS_FOR_TEST_PROJECTION_ONLY` by WS3.
- Production WorkerControlAuthority / authenticated receipt / TaskClaim issuer / signed-byte profile: `BLOCKED / NOT_ASSIGNED`.
- Durable historical receipt lookup after restart/expiry/reassignment: `NOT PROVEN`.
- CR-03 and CR-09: `OPEN / BLOCKING`.
- Contracts: `DRAFT / NOT RATIFIED`; production/release readiness `NOT PROVEN`.

Main repository HEAD remains `2f3599000d9a8dd8ff61b2651478eb27ceec88f3`. WS2 test and addenda remain untracked; no staging, commit or push.
