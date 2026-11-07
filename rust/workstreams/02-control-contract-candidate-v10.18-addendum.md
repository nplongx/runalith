# WS2 Control Contract Candidate V10.18 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.17 SHA-256 `4ce17d536461586d1a88d3e1bcf95e33ad53e2270cbe516a9528226aa3b09429`  
**Scope:** WS3 renewal consumer review and repeated WS8 export verification.

## 1. WS3 prepared renewal consumer update — independently verified

WS3's current consumer-source hashes were independently recomputed:

- `runalith-worker/src/control_http.rs`: `528a43ac631217ba2ad1e7ff6595ce52b227d447e17097cfe87ea1cf02407e17`.
- `runalith-worker/src/lib.rs`: `f1fb8b16b83bc8562cf75151661e35145cb6e7688e60cc6e499595d5cd623ca8`.
- `runalith-worker/src/config.rs`: `a774dd5df997ed1bf1418f4044e933008da5db9fab767077f98372707dad0397`.

WS2 independently ran in the WS3 Rust worktree:

```bash
cargo test -p runalith-worker control_http::tests --locked --offline
cargo test -p runalith-worker --locked --offline
cargo fmt -p runalith-worker -- --check
cargo clippy -p runalith-worker --all-targets --locked --offline -- -D warnings
```

Results: `control_http` **20/20 PASS**; full worker crate **103 library + 3 binary tests PASS**; fmt PASS; Clippy PASS.

The new `PreparedLeaseRenewalJournal` is a useful caller-owned immutable request journal: mode-0600 records, mode-0700 directory, fsync/atomic no-overwrite insert, stable renewal ID/body/checksum, exact restore/retry, duplicate-identical idempotency and corruption/symlink/size checks. But it is not integrated into supervisor execution/recovery. WS2 verified `supervisor.rs` calls generic `ControlPlane::renew_lease` for initial renewal, recurring renewal and heartbeat (lines 385, 582, 1074); `HttpControlPlane::renew_lease` still creates a new UUID and sends immediately (`control_http.rs` lines 861–867). Journal references outside its implementation occur only in module exports and unit tests; no supervisor journal load/persist path exists. Thus this is a tested consumer utility, not crash-recoverable normal supervisor renewal.

The strict consumer parser accepts exactly ten response fields matching current Store `TaskLeaseRenewal` field names. It has no `claim_id` or `receipt_id`; these exist only in separate proposed draft structs under `draft_contracts.rs`. Request remains `{renewal_id, claim, lease_seconds}`. No producer-side Control API change was found.

WS2 rechecked current Control API source:

- `WorkerControlAuthority::renew_lease` is `&Value -> Value` (`runalith-control-api/src/lib.rs` lines 95–100).
- HTTP route validates minimal claim/renewal_id/TTL fields, invokes the opaque authority, and accepts any returned JSON object (lines 512–541, 625–629); it does not enforce the strict 10-field DTO.
- `ControlApi::from_store` sets `worker_control=None`; standalone `serve_command` does not call `.with_worker_control_authority(...)` and therefore worker-control routes fail closed with 503 (main.rs lines 745–759).
- Search of `rust/crates` finds only test `FakeWorkerAuthority`; no concrete Store-backed adapter.
- Current Store `TaskLeaseRenewalRequest` has no `claim_id`; `TaskLeaseRenewal` has no `receipt_id`.

**Disposition:** WS3 durable prepared-request utility and strict response parser `TESTED`; Store DTO field/TTL compatibility `VERIFIED`; Control HTTP producer response `NOT PROVEN`; standalone server backend `NOT WIRED`; supervisor journal/restart retry `NOT INTEGRATED`; claim/receipt provenance `ABSENT`; end-to-end renewal acceptance `NOT PROVEN`. WS2 reply to WS3: `c9546bca-6f18-474a-8209-fbda073d4c5b`.

## 2. R5.4.2 package verification still fails

WS2 reran `python3 -B verify-export.py` in `/home/long/work/WS8-R5.4.2-EXPORT-20261103` after WS8's mapping-document reconciliation. Result remains exactly `MANIFEST.sha256 missing or not a regular file`. The export package is not integrity-verified. WS2 requests WS8 generate its outer manifest and prove `EXPORT_INTEGRITY_PASS`; no WS2 operation modified the WS8 export.

## 3. Mapping and cross-workstream status

- WS8 mapping V3: WS2 and WS1 independent PASS; structural mapping accepted with blockers for canonical R5.4.2 bytes only. Document hash `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`; example `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`; validator `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`.
- WS3 V3 mapping review request `d148c50c-3cec-4511-b537-8b33e867cf43`: pending.
- WS7 V3 mapping review request `9a13f058-8493-4d24-8edc-076819b8f309`: pending.
- WS8 outer manifest request `b958770c-7d26-4428-98ff-8f1a63975524`; follow-up `e0697118-c4be-42cf-9e79-2a8852e1db38`: pending.
- WS1 status response `581d9e3b-f5d9-4002-90a9-9ce8194052b1`: mapping review pending state relayed; WS1's separate WS7 v0.5.1 archive status is not evidence of WS2 mapping review closure.
- Project Owner/Host Security remains `NOT_ASSIGNED`; no migration or production authorization.

Latest WS2 inbox read through sequence **1085**.

**Overall:** WS3 consumer-side lease renewal preparation has stronger tests but remains unintegrated; Control producer path remains NOT WIRED; mapping V3 accepted structurally with blockers; WS3/WS7 mapping reviews pending; R5.4.2 export package integrity NOT VERIFIED; authority NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.
