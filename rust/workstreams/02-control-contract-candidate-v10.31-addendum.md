# WS2 Control Contract Candidate V10.31 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.30 SHA-256 `50a750f800c20241669b93394d57c42d0b07d684b41ce43235ac2eb007a9efbf`

## 1. WS3 current renewal-journal candidate — final exact revalidation

Worktree: `/home/long/work/chatgpt-adapter-ws3-20261103`; HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`. Rust candidate remains untracked/unmerged, outside main checkout.

Exact source hashes after full test, fmt and Clippy:

- `crates/runalith-worker/src/control_http.rs`: `6dc1340ec8cfa3c89486c5335fdf40006e230b43c9c6d34218009a9249a929c3`
- `crates/runalith-worker/src/supervisor.rs`: `5a1bd3b87d3ed6f70887bba5b3024c594368d427333a00a41dcd1276dac12ab2`
- `crates/runalith-worker/src/main.rs`: `d66f08a8340f2dea73594b163ff5173d14561ee4ab49e84d7b3917cadd4157a3`
- `crates/runalith-worker/src/lib.rs`: `f1fb8b16b83bc8562cf75151661e35145cb6e7688e60cc6e499595d5cd623ca8`
- `crates/runalith-worker/src/draft_contracts.rs`: `2ae9c276aef1f8ed48c6870c9857e5bd5a5351a259c648396f285412872eaf18`

Full command:

`CARGO_TARGET_DIR=/dev/shm/ws2-ws3-current-verify-target cargo test -p runalith-worker --locked --offline --jobs 1 -- --test-threads=1`

Result: **110 library +15 main tests PASS, 0 failed**. Main suite includes `persistent_identity_registry_supports_concurrent_first_start`.

Same final tree:

- `CARGO_TARGET_DIR=/dev/shm/ws2-ws3-current-verify-target cargo fmt -p runalith-worker -- --check` — PASS.
- `CARGO_TARGET_DIR=/dev/shm/ws2-ws3-current-verify-target cargo clippy -p runalith-worker --all-targets --locked --offline --jobs 1 -- -D warnings` — PASS.

Post-validation hashes still equal the pins above. No WS3 source was edited by WS2.

### Superseded compile-failure report

WS1 review seq1389 reported five compile errors against `main.rs` SHA `f6b6f25f04ec6f8969491ef19319f4f171b40cabf1a84ec468d597e562b41cc9`; V10.28 had an older `58ccbe5a...` pin. Those bytes are not current. WS2 independently built/tested the later current `d66f08a...` with clean `/dev/shm` target and full 110+15 passed. Intermediate `75091fdc...` passed 110+14 but was superseded. The final exact evidence is `d66f08a...` plus 110+15/fmt/Clippy; do not reuse earlier pins as current.

### CR-03 disposition

WS3 integrates `PreparedLeaseRenewalJournal` into `main.rs`/supervisor. Unresolved renewal is prepared and persisted before sending; supervisor reconciles before new claims; ambiguous outcome preserves exact ID/body and restart replays before new claims. **Accepted with blockers for local consumer retry/restart only.**

WS3 A2A seq1397 / message `29899854-ee4f-444b-9d88-638f8ad4ada1` agrees with WS2's Store/HTTP boundary description:

- `{renewal_id,claim,lease_seconds}` and ten-field receipt are current consumer/current Store shapes, not approved HTTP DTO;
- separate LeaseRenewalV1 draft stays unratified; no alias/enrichment/byte compatibility inferred;
- Store same-live-lease replay is not historical replay after expiry/terminal/quarantine/reassignment, nor authenticated receipt;
- no Store-backed `WorkerControlAuthority`/production HTTP route proven; `ControlApi::from_store` authority None and standalone 503 remain blockers.

V10.29 (SHA `eb09c7a4ac26748722c07fca38164c6c2eef22ffabb84e450c34e9abda7290fe`) retains exact Store request/receipt/CAS evidence. WS3 said V10.29 file was not present in its worktree, so it acknowledged the A2A technical response, not an independently rehashed addendum.

**CR-03:** `ACCEPTED_WITH_BLOCKERS_FOR_LOCAL_RENEWAL_RETRY_CONSUMER`; overall `OPEN / BLOCKING / DRAFT_NOT_RATIFIED`. Control HTTP producer/Store adapter, claim issuer/signing/audience authority, exact common LeaseRenewal DTO and authenticated receipt remain absent.

## 2. WS8 current reference dispatcher — supersedes old source pins

Worktree `/home/long/work/chatgpt-adapter-ws8-20261103`, HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`.

Latest identities verified by WS2:

- `08-gateway-dispatch.rs`: `ee212f9828258fc82804cfbb8c2ce96ae5679df359285bbbd57752b700e9768b`.
- Node/Rust differential: `b07f13204f2d21f47cb1081395f479ceeb6e73945e768b2c29cf91b3ace3adc1`.
- Probe: `a59adf2d9bad7704aa9e8b669c88ad9d2a968b10cd3573e443d657655ed182cd`.
- Version negotiation primitive: `f21cd14473c975e188fd82b81ef4849516f42c0fb00dcab98bc0d7cd58b9bf37`.
- WS8 acceptance reconciliation: `ba6daf85840414ebeca4e7e730fef6e67d0768e7928d357e903de7145a1bbe1d`.

WS2 independently compiled/ran latest dispatcher: **41/41 Rust tests PASS**. Probe + Node differential: **5/5 PASS**. This supersedes `a8aa...`/31 tests, `2bf146...`/33 tests, and prior reconciliation `2cb106...`.

Newly covered behavior: successful response binding checked inside dispatch; MCP JSON-RPC ID link preserves string/null/number identity including number lexeme through exact envelope causation/correlation; route request/response byte caps; deadline budget forwarded to service and over-deadline mutation becomes UNKNOWN/no retry; UNKNOWN mutation preserves producer domain_code/cause_code; invalid response binding/oversized response after mutation becomes UNKNOWN; replay reservation and replay receipt persistence faults fail closed.

Bounded behavior accepted with blockers: version before auth/route/service; host-injected principal; route-derived audience/capability/effect; exact payload bytes to digest verifier; producer idempotency key forwarded unchanged; ordering delegated to owning service; duplicate replay/conflict; ambiguous mutation UNKNOWN/no auto-retry; producer domain/cause codes preserved.

Remaining blockers: replay and digest verification are injected ports with mock/in-memory tests, not production durable store/crypto; MCP JSON-RPC bridge functions remain reference code not called by live `runalith-mcp`; route object is not a full approved registry with stable route ID, schema IDs/version ranges, idempotency policy, error-map version and compatibility window; deadline cannot cancel a blocked service in this synchronous reference; no authenticated remote route, live MCP wiring, three-deployable integration or Common Envelope ratification.

**CR-09:** `ACCEPTED_WITH_BLOCKERS_FOR_REFERENCE_DISPATCH_SEMANTICS_ONLY`; overall `OPEN / BLOCKING`. Common Envelope v1.0.0 remains DRAFT/NOT RATIFIED; WS8 owner and Execution-host authority remain unassigned.

## 3. WS1 plan digest clarification

WS1 A2A seq1389 accepts bounded outer-envelope rules with blockers and clarifies claim `plan_sha256`: bind outer `PlanDigestV1.value` from exact approved `CompiledPlanV1` (inner workflow plan + workflow definition pin + role definition pins + skill pins + optional policy composition). Do not substitute inner legacy `workflow_plan.plan_hash` or envelope `payload_digest`. WS1 owns plan/digest definition; WS2 owns claim issuance and wire mapping. Not claim authenticity or ratification.

## 4. Current dispositions

| Work | Status |
|---|---|
| WS3 local renewal retry consumer | Accepted with blockers; latest 110+15, fmt, Clippy PASS |
| WS2 Store renewal/fence | Implemented/tested locally; public HTTP/auth receipt adapter blocked |
| TaskClaim issuer/signer/audience | Not assigned/not ratified/blocked |
| WS4 provider schema v7 | Proposed; migration not approved; no ambient account backfill |
| WS8 reference dispatcher | Accepted with blockers, reference only; 41/41 +5/5 PASS |
| CR-03 | OPEN / BLOCKING |
| CR-09 | OPEN / BLOCKING |

No production source, API schema, SQL migration, trigger, WorkerStore, Control Store, provider-intent table, signer, route, ACL or deployment file changed. WS3/WS4/WS8 candidate trees remain isolated/unmerged. No commit/push. New WS2 evidence remains untracked.
