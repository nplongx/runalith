# WS2 Control Contract Candidate V10.36 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.35 SHA-256 `0cb1a405998be81f7ed869eb37796e86935f0eacc77c480acc8c2803cf0d333e`  
**Purpose:** supersede V10.35's WS3 source pin with the latest peer report; record WS6's latest written no-authority/no-migration status and the current WS3 receipt compatibility follow-up.

## 1. Current WS2 test-only integration snapshot

`rust/crates/runalith-control-api/tests/worker_store_boundary.rs` SHA-256:
`876db56147e70b1536e09fe8cd537d30be6d7f5c2c9c96fd674524f6b56938f6`.

This current snapshot extends the earlier route→Store harness to cover renewal, result inbox and ExecutionFence route semantics. It remains test-only; no production `ControlApi`, Store, runtime, schema, SQL, service, manifest, ACL or deployment code changed.

### Current exact tests / validations

```sh
cargo fmt -p runalith-control-api -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-control-api --test worker_store_boundary --locked --offline --jobs 1 -- --test-threads=1
cargo clippy -p runalith-control-api --all-targets --locked --offline -- -D warnings
```

Observed: **4/4 focused integration tests PASS**, fmt check PASS, package-wide Clippy `-D warnings` PASS; all exit 0.

The four tests cover:

1. Lease renewal route exact replay, same-ID changed-TTL conflict, wrong worker and out-of-range TTL rejected before Store.
2. Task-result route to Store result inbox: exact event replay, changed body conflict, stale lease rebind conflict, second event identity for same attempt conflict, worker principal mismatch denied before backend.
3. ExecutionFence V2 reservation route exact replay, changed side-effect digest conflict, UNKNOWN observation exact replay, changed ACL/event conflict, no proof for SUCCEEDED returns 503 without release.
4. Exact V2 receipt key sets for reservation/completion.

### WS3 receipt compatibility correction

WS3 seq1522 (`a1fe7977-56e7-4918-8a5f-47bcedf9ce06`) reviewed earlier snapshot `92f664...` and correctly identified extra `control_store_request_sha256` in both public receipts, which violates WS3 draft `deny_unknown_fields` shapes.

The current `876db...` snapshot omits that field from both public receipts and asserts exact keys. The Store full-request digest remains an internal detail with an internal debug assertion; it is not present in public V2 response bytes. The V2 `request_sha256` remains the side-effect request digest. The completion receipt includes only draft fields, including idempotency key and ACL digest.

WS2 requested a fresh WS3 review for exact current hash via A2A message `7dd8bcd4-862b-4b34-b36c-78ba1c700f11` (correlation `WS2-WS3-RECEIPT-FIX-20261104`), queued/durable. No WS3 confirmation of the corrected snapshot yet.

Limitations remain unchanged: adapter lives only under tests; the repeated completion idempotency/ACL comparison uses a process-local map; receipt IDs are deterministic projections, not independently persisted IDs; no production signer, authenticated receipt, Store-backed `WorkerControlAuthority` or historical reservation lookup after owner expiry/transfer. Therefore this does not activate the standalone `/v1/worker/*` routes or ratify a public cross-part contract.

## 2. Latest WS3 worker source / acceptance report (peer-reported)

WS3 seq1540 (correlation `WS2-WS3-CURRENT-WORKER-PIN-AND-V2-REVIEW-UPDATE-20261104`) supersedes prior reported `main.rs c0075936...` with a further host-preflight hardening change.

Latest WS3-reported pins:

- `crates/runalith-worker/src/main.rs`: `6f9eb7dacadf9ee7449bac3d52707d7cbbd6657fc1851204d0f28535cfebc18c`.
- `crates/runalith-worker/src/config.rs`: `e40c9c44acd6c10d19ef66c2210bd1e2a6a4cf2b73db956dda013f4cd2b5c273`.
- `crates/runalith-worker/src/draft_contracts.rs`: `2ae9c276aef1f8ed48c6870c9857e5bd5a5351a259c648396f285412872eaf18`.

WS3 reports: binary suite 24 PASS +1 explicit ignored; separate cross-UID/socket regression 1/1 PASS; config 2/2; Clippy/fmt/build PASS. The hardening checks effective socket group as well as root owner/mode. These are WS3 peer-reported source hashes/results, not independently rerun by WS2. Active runtime remains TaskClaim V3 + V1 HTTP renewal/fence; V4/V2 successor DTOs remain structural draft-only, authenticator `fixture_only / NOT_A_SIGNATURE`. No canonical signed-byte profile, issuer/key trust, freshness high-water or nonce/replay authority exists.

## 3. Latest WS6 authority / D-01 / D-02 disposition

WS6 seq1517 and seq1518, both responding to WS2 relay of WS4 provider-origin request, explicitly state:

- Project Owner / Host Security appointment authority: `NOT_PRESENT` in the current A2A directory; no owner decision artifact or delegated appointment authority supplied.
- Provider-origin trust owner, production key custodian, signer, independent verifier and acceptance approver: `NOT_ASSIGNED`.
- Production trust roots, algorithm/key IDs, issuer/provider/account/audience/scope, selected proof mode, freshness/expiry, revocation/high-water and commit-time fence: `NO_DECISION / NOT_AUTHORIZED`.
- Durable nonce/replay authority and provider receipt verification API/golden vectors: `NOT_ASSIGNED / NOT_RATIFIED`.
- Existing WS6 `EvidenceVerificationReceiptV1` is not a provider-origin or V2-01 contract and is not approved as a substitute.
- D-01 approval-high-water/transaction ownership remains unresolved. D-02 global writer barrier is separate and not approved. No shared DB, migration, provisioning or cutover authorized.

WS6 requires an authorized human appointment/decision artifact that names accountable owner and approver, scopes the exact role and source/spec hashes, before WS4 defines provider proof lineage and WS6 establishes a separately versioned trust-verification contract and test vectors.

## 4. A2A queue/delivery evidence

- WS2→WS3 exact receipt correction review `7dd8bcd4-862b-4b34-b36c-78ba1c700f11`: `queued`, durable. No response yet.
- WS2→WS6 latest W3 pins + corrected WS2 projection update `4f75adae-6e64-4ac9-872e-5c214bc6601e`: `queued`, durable. No WS6 response yet.
- WS3 reports its relay of W2 Control/Store facts to WS4 as `831737e9-8f52-4be7-8b6e-6e631a5a4722`, `queued/durable`; WS4 has not read/accepted as of WS3 seq1512/1523.
- Direct WS2→WS4 remains recipient-ACL denied. No ACL was changed.
- WS6 acknowledged earlier relay delivery-status and WS3 consumer pin messages (seq1519/1521); these are receipt ACKs only, not authority approvals.

## 5. WS2 disposition

Current test-only public-port integration: **IMPLEMENTED_IN_TESTS / TESTED** (4/4, fmt, Clippy PASS). WS3 receipt field-set mismatch from the previous snapshot was removed; fresh peer confirmation is pending. Production authority, claim signer/issuer/audience, authenticated receipts, durable restart-safe public receipt lookup, provider terminal proof, D-01/D-02 and WS4 migration approval remain **BLOCKED / NOT_ASSIGNED / NOT_AUTHORIZED**.

**CR-03:** `OPEN / BLOCKING`. **CR-09:** `OPEN / BLOCKING`. Contracts remain `DRAFT / NOT RATIFIED`. Production/release readiness `NOT PROVEN`. Main repo HEAD remains `2f3599000d9a8dd8ff61b2651478eb27ceec88f3`; all W2 artifacts remain untracked; no files staged/committed/pushed. No production source/schema/SQL/ACL/deployment change.
