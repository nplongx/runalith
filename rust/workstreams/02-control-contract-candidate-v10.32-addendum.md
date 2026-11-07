# WS2 Control Contract Candidate V10.32 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.31 SHA-256 `2379e9bc4362209120374fda2ca578aa2842f985d3e2299ab3bcdf893c5430bc`  
**Purpose:** record fresh current-tree validation for the three W2 primary Rust crates in addition to V10.31's latest WS3/WS8 cross-workstream evidence.

## 1. Exact source hashes

Main worktree `/home/long/work/chatgpt-adapter`, HEAD remains `2f3599000d9a8dd8ff61b2651478eb27ceec88f3`.

- `crates/runalith-control-api/src/lib.rs`: `9044441a6fab7e15a7953d39ba2b36acacca9af7a98b7929f51cf867477bb0ce`
- `crates/runalith-control-api/src/main.rs`: `aea660103453d9f533cac1c71c8a2bead311dc894064de2bc15d760a7f4e31a4`
- `crates/runalith-recovery/src/lib.rs`: `72b9079d2209e170aba6dfc1b4df5960e98cba444778d7d6593e32024b3739d5`
- `crates/runalith-store/src/lib.rs`: `a08e43b192d02666f8b5956fa8122bd6acaf996524160c4414d5870e49ffe3e3`

These exact hashes were computed after test, fmt and Clippy commands below. The crates remain part of the isolated/untracked Rust candidate tree; this validation does not make them committed, deployed or extracted into separate databases.

## 2. Full current W2 primary crate tests

Command from `rust/`:

`CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target cargo test -p runalith-control-api -p runalith-recovery -p runalith-store --locked --offline --jobs 1 -- --test-threads=1`

Observed results:

- `runalith-control-api`: 26 library +8 binary +11 standalone-process tests = **45 PASS**.
- `runalith-recovery`: **15 PASS**.
- `runalith-store`: **99 PASS**.
- Total: **159 tests passed, 0 failed**, exit 0. Doctest suites contained 0 tests and completed successfully.

The Control API suite explicitly includes fail-closed worker routes when authoritative backend is not configured, authenticated worker subject/capability binding, worker execution-fence body/identity path, HTTP parser security, recovery capability and standalone process/backup/restore cases. It does not prove a concrete production Store-backed `WorkerControlAuthority`; the 503 behavior remains expected when authority is absent.

Recovery suite includes unknown provider outcome remaining unresolved, lease/session ownership blockers, explicit authoritative absence from every owner, complete/fresh runtime snapshots and refusal to terminalize on incomplete inventory.

Store suite includes transaction/CAS and cross-connection races, exact lease renewal replay across Store restart, changed-ID/body conflicts, expiry/quarantine fencing, execution-fence reservation/completion, historical observation receipt replay after restart/terminal reconciliation, independent proof for `NOT_STARTED`, event-chain tamper detection, result inbox idempotency and fail-closed migration/health cases.

## 3. Format and lint

Commands from `rust/`, same `CARGO_TARGET_DIR`:

- `CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target cargo fmt -p runalith-control-api -p runalith-recovery -p runalith-store -- --check` — PASS (exit 0).
- `CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target cargo clippy -p runalith-control-api -p runalith-recovery -p runalith-store --all-targets --locked --offline --jobs 1 -- -D warnings` — PASS (exit 0).

## 4. Limits / acceptance state

These checks establish current local build/test/lint evidence only. They do not authorize source integration or whole-repository formatting; do not imply that `runalith-store` is a Control-only database. The current Store schema remains a mixed compatibility aggregate. No D-01 migration/split, production Store-backed worker authority, TaskClaim signing/key provisioning, authenticated receipt issuer, cross-part cancellation settlement, provider terminality decision, route publication or deployment is proven.

V10.31 remains the current exact cross-workstream evidence for WS3 worker `110+15` tests/fmt/Clippy and WS8 reference dispatcher `41/41` + Node/Rust `5/5`. V10.32 adds the W2 primary crate `159/159` validation; it does not supersede their source pins.

**CR-03:** OPEN / BLOCKING. **CR-09:** OPEN / BLOCKING. All contracts remain DRAFT / NOT RATIFIED; production/release readiness NOT PROVEN. No source/schema/SQL/API/ACL/production file was changed by this validation. No commit or push.
