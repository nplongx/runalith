# WS2 Control Contract Candidate V10.39 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.38 SHA-256 `69f856e36a9be97e88e1189121602160ddafb406e4b7ef06ff9e11dbe39f9910`  
**Purpose:** supersede V10.38's four-test route→Store harness with a five-test snapshot that explicitly proves delayed old-attempt result rejection after expiry/quarantine; record updated full Rust package evidence and WS8's independent registry review / WS4 relay.

## 1. Updated W2 route→Store integration artifact

File: `rust/crates/runalith-control-api/tests/worker_store_boundary.rs`  
SHA-256: `df45a1b8f5b4844ff14b5a49d42d6e10b4d82238e584bba85049353ddab76a2d`

This is still test-only. The only source change since prior accepted snapshot is in `tests/worker_store_boundary.rs`:

- `Harness` retains `Arc<Store>` so the test can trigger the real Store quarantine path and inspect the post-quarantine workflow state.
- `harness_with_lease_ttl(lease_ttl_seconds)` permits a one-second expiry fixture; default harness remains 60 seconds.
- New test `public_result_route_rejects_delayed_old_attempt_after_expiry_quarantine` waits until the exact lease is expired, calls `Store::quarantine_expired_leases()`, then submits the old result through authenticated `POST /v1/worker/results`.
- Assertions: quarantine count = 1; delayed result returns HTTP 409; task remains `UNKNOWN`; attempt remains 1; worker authority adapter invoked once; no result accepted or task reopened.

The four existing tests remain intact: lease renewal exact replay/conflict; worker/TTL boundary rejection; result-inbox exact replay/changed-body/stale-lease/second-event/principal checks; ExecutionFence V2 draft route projection/receipt key-set/subject/UNKNOWN/no-proof checks.

## 2. Exact validation on SHA `df45a1...`

```sh
rustfmt --edition 2024 crates/runalith-control-api/tests/worker_store_boundary.rs
cargo fmt -p runalith-control-api -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-control-api --test worker_store_boundary --locked --offline --jobs 1 -- --test-threads=1
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy -p runalith-control-api --all-targets --locked --offline --jobs 1 -- -D warnings
```

Observed:

- Focused route→Store integration: **5 passed, 0 failed, 0 ignored**.
- `cargo fmt -p runalith-control-api -- --check`: PASS.
- all-target `runalith-control-api` Clippy `-D warnings`: PASS.

WS3's prior independent acceptance was for the four-test SHA `876db...`, bounded to V2 receipt JSON compatibility only. The new five-test SHA was sent for re-review as A2A message `480d731a-300d-40a3-a2ba-74deaa813d00`, queued/durable. No response yet; do not silently extend WS3's old hash-bound disposition to this new test body.

## 3. Updated combined Rust tests

Exact command on current checkout:

```sh
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-control-api -p runalith-recovery -p runalith-store --locked --offline --jobs 1 -- --test-threads=1
```

Observed:

- Control API: **50/50** (26 library +8 binary +11 standalone-process +5 route→Store integration).
- Recovery: **15/15**.
- Store: **99/99**.
- Total: **164/164 PASS**, exit 0.

This replaces V10.38's 163/163 total. The 5th integration test adds delayed TaskResult after expired-lease quarantine. Store and Recovery source were not changed.

Combined formatting/lint on current checkout:

```sh
cargo fmt -p runalith-control-api -p runalith-recovery -p runalith-store -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy -p runalith-control-api -p runalith-recovery -p runalith-store --all-targets --locked --offline --jobs 1 -- -D warnings
```

Both PASS, exit 0, on the current worktree after the 5-test addition.

Other recent local evidence from V10.38 remains current because its code inputs did not change: Trust 90/90 + fmt/Clippy; Domain 62/62 + fmt/Clippy; Node lifecycle oracle 8/8; workspace `cargo check --workspace --locked --offline` PASS; registry and V2.3.3 validators PASS.

## 4. WS8 independent review of route/MCP/digest registry

WS8 inbox seq1620 / message `4b78aa69-0a3a-4dad-8157-225114b009eb` disposition:

`ACCEPTED FOR SOURCE INVENTORY FACTS ONLY / DRAFT_NOT_RATIFIED`.

WS8 independently checked exact hashes and ran the validator for:

- JSON `c635f49d3afc8be9cfd165aa69791f819062d3a3dfb1dab65761532d04fd3f28`;
- Markdown `d5ed4d2b71a613acc069f2d22c419a76a526f70b7b185daedc8467de34519cc5`;
- validator `efce2d959dd785f2930ad03f53d94ed46653a827efebf92a272bd1b2efbe6d89`.

WS8 confirms the exact 62 registered MCP tools, explicit 14-tool local read-only Gateway allowlist, JSON-RPC request ID conversion to `McpServiceRequestV1.request_id` using `Value::to_string()`, correlation identity `stdio:{connection_id}`, host-composed principal, `idempotency_key=None`, and mutating MCP fail-closed behavior with `MUTATION_IDEMPOTENCY_UNAVAILABLE` and `handler_invoked:false`. MCP service request/response define no digest; response identity binding is schema/request_id/service_id and serialized-size limit.

WS8's precision constraints are retained:

1. `Value::to_string()` is an identity/correlation mapping, not a reversible typed ID contract or durable idempotency key. JSON-RPC accepts bounded strings and safe finite numbers, not null/arrays/objects; response retains original JSON-RPC Value.
2. The 1 MiB MCP frame and service-message limits are distinct guards; Control HTTP body limit is a third separate boundary. Do not represent them as a shared end-to-end budget.
3. The 14-tool allowlist is the local stdio Gateway surface, not a W8 Common Envelope remote route registry.
4. Tool catalog annotations do not override service/Gateway allowlist. `workflow_recovery_quarantine_expired` and `workflow_provider_reconcile` remain excluded despite old `readOnlyHint` metadata.
5. Workflow route mappings and non-mappings are source-consistent; direct `workflow_claim_task` is not coordinator tick, provider reconciliation is not worker provider-results publication, session enqueue is not worker session delivery.

This accepts source inventory facts only. No W8 Common Envelope schema, MCP mutation, Control producer DTO, route activation, stable error transport extension or cross-deployable protocol is ratified.

## 5. WS4 provider evidence relayed by WS8

WS8 inbox seq1621 / message `e4456fcd-5227-4ae4-9c4e-59f3a30ec8f2` relays WS4 response `085c5dc6-c7a1-4b82-b2ad-a02fcdf18cb8`. WS4-reported facts:

- One concrete V1 provider adapter exists (GitHub Actions); contract/source pins and Node oracle 6/6 are peer-reported.
- V1 flow uses at-most-once POST followed by exact lookup; ambiguous send remains UNKNOWN; NOT_SENT requires complete exact-scope absence.
- It is not wired into Worker `ProviderPoller`, which still uses legacy `ProviderAdapter`.
- V2 remains DRAFT / NOT RATIFIED / NOT WIRED; account/config snapshot and first-class attempt are proposed; schema v7 migration unauthorized; v6 has no backfill and stays quarantined.
- No provider-origin proof mode, signer/issuer/audience/scope/root/key custodian/nonce owner is appointed. TLS and hashes are not provider-origin proof. `ProviderTerminalProofVerifier` remains an injected port.
- WS4's latest persistence source pin `a9a41dac62f861284d27264386464744e78f89ef0ea6f0670a51531519279da7` is reported after hardening; WS4 says Cargo gates are pending, therefore no test/build acceptance is inferred.
- Control has no production `WorkerControlAuthority`; worker API routes default 503; historical renewal lookup after expiry/reassignment absent.
- WS4 states WS6 authority NOT_ASSIGNED / NO_DECISION / NOT_AUTHORIZED / BLOCKED; D-01 unresolved; D-02 not approved.

This is producer-reported evidence relayed by WS8, not WS2 verification and not contract acceptance. WS2 forwarded it to WS6 as message `7557659c-61c6-4247-a564-a08278d82912`, queued/durable.

## 6. A2A state

- WS3 latest route→Store re-review of new SHA `df45a1...`: message `480d731a-300d-40a3-a2ba-74deaa813d00`, queued/durable; no response yet.
- WS8 registry review: seq1620 received and ACKed; accepted source inventory facts only.
- WS8 provider review relay: seq1621 received and ACKed; WS4 facts remain peer-reported.
- WS6 V2.3.3 live-source/line-map review: `488dca42-b076-4782-aebd-6bd91481b710`, queued/durable; no response yet.
- WS1 registry/PlanDigest review: `b1b32d1e-c534-46f1-9c5a-f79a80f48288`, queued/durable; no response yet.
- WS2→WS6 provider relay update: `7557659c-61c6-4247-a564-a08278d82912`, queued/durable; no response yet.
- Direct WS2→WS4 remains recipient-ACL denied; no ACL change.
- WS3 older acceptance remains bound to old harness SHA `876db...`; the current SHA `df45a1...` requires the new review response.

## 7. Remaining blockers / scope

1. No production Store-backed `WorkerControlAuthority`, TaskClaim issuer/signer/key custodian, signed-byte profile or authenticated durable receipt.
2. ExecutionFence V2, LeaseRenewal V1 and TaskClaim V4 remain DRAFT / NOT RATIFIED; the corrected JSON projection is test-only.
3. No provider-origin terminal proof, no owner-appointed verifier/key/nonce authority, no D-01/D-02 approval, no W4 migration.
4. No live mutating MCP Gateway routes or live W8 Common Envelope route activation.
5. No production Control DB extraction, migration or three-deployable deployment/rollback proof; schema-v20 Store remains mixed compatibility aggregate.
6. Compiled-plan V2 policy-compatibility validator still confirms positional role alias `custom-task-N` instead of stable `custom_role_id`; no shared-source fix is authorized here.
7. CR-03 and CR-09 remain OPEN / BLOCKING; global issue #58 and persistence issue #48 remain open.

## 8. Final W2 disposition

- Local Control/Recovery/Store: **TESTED 164/164 PASS**.
- Current worker route→Store integration: **TESTED 5/5 PASS**, including delayed old-attempt result after quarantine.
- Current Control/Recovery/Store fmt and all-target Clippy: PASS.
- Domain Node differential: 62/62; Trust package: 90/90; Node lifecycle oracle: 8/8; workspace check: PASS.
- Registry: `ACCEPTED FOR SOURCE INVENTORY FACTS ONLY` by WS8; DRAFT_NOT_RATIFIED.
- ExecutionFence V2 receipt projection: earlier exact snapshot `ACCEPTED_WITH_LIMITS_FOR_TEST_PROJECTION_ONLY` by WS3; latest five-test snapshot review pending.
- V2.3.3: source pins and bounded line map structurally validated; WS6 review pending.
- Cross-part contracts: DRAFT / NOT RATIFIED. CR-03/CR-09 OPEN / BLOCKING.
- Production/release readiness: **NOT PROVEN**.

Main repository HEAD remains `2f3599000d9a8dd8ff61b2651478eb27ceec88f3`. All new WS2 files remain untracked; nothing staged, committed or pushed. No production source, Store schema, SQL, migration, API manifest, ACL, credential, database or deployment changed.
