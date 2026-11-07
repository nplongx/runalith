# WS2 Control Contract Candidate V10.28 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.27 SHA-256 `aa6a3c9653d0ba904c22276cd15152e5e8e0cdd8810fe226d37d02bd5ef8370a`  
**Purpose:** reconcile CR-03 with current WS3 renewal-journal implementation and WS6 authority ownership; publish updated WS2 CR-09 Common Envelope review; record V2.3.2 live-source check.

## 1. CR-03 WS2 ↔ WS3 — renewal retry subcomponent updated, overall still BLOCKING

### 1.1 WS3 current isolated candidate independently revalidated

Worktree: `/home/long/work/chatgpt-adapter-ws3-20261103`  
HEAD: `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`  
`rust/` candidate remains untracked/unmerged; not in main repository HEAD and not deployed.

Exact current source hashes:

- `runalith-worker/src/control_http.rs`: `6dc1340ec8cfa3c89486c5335fdf40006e230b43c9c6d34218009a9249a929c3`
- `runalith-worker/src/supervisor.rs`: `5a1bd3b87d3ed6f70887bba5b3024c594368d427333a00a41dcd1276dac12ab2`
- `runalith-worker/src/main.rs`: `58ccbe5a06fef34580d0faeb85e81c7488ccbdcfc97868ce4ff2641e96beb290`
- `runalith-worker/src/lib.rs`: `f1fb8b16b83bc8562cf75151661e35145cb6e7688e60cc6e499595d5cd623ca8`
- `runalith-worker/src/draft_contracts.rs`: `2ae9c276aef1f8ed48c6870c9857e5bd5a5351a259c648396f285412872eaf18`

WS2 reran full `cargo test -p runalith-worker --locked --offline`: **110 lib +3 main PASS**; `cargo fmt -p runalith-worker -- --check` PASS; `cargo clippy -p runalith-worker --all-targets --locked --offline -- -D warnings` PASS. Targeted supervisor/HTTP tests each passed 1/1: prepared renewal persists before initial send; ambiguous timeout replays exact request after restart; unresolved renewal reconciles before receiving a new claim; prepared HTTP body retries exact bytes. WS1 independently reported the same full suite/fmt/clippy results and WS8 acknowledged the correction in A2A seq1289.

The current production `main.rs` opens `PreparedLeaseRenewalJournal` under `config.data_dir/lease-renewals` and injects it into `WorkerSupervisor`. `run_once` calls `reconcile_pending_renewals` before receiving new claims. Initial and periodic heartbeat flows use prepare → persist → send → validate → confirm. An ambiguous/invalid response is kept UNKNOWN and fails closed; restart replays the exact prepared request before new claims. Each independent new heartbeat gets a new renewal ID; only retry of the same unresolved heartbeat reuses ID/body.

**Bounded disposition:** `ACCEPTED_WITH_BLOCKERS_FOR_LOCAL_RENEWAL_RETRY_CONSUMER`. This closes the Worker-side durable preparation/restart/replay subcomponent only in the isolated WS3 candidate. It does not close Control's HTTP producer, claim issuer, signature/audience authority, Store adapter, cross-part DTO version, cross-workstream signoff, merge or deployment.

### 1.2 W2 Store renewal semantics and HTTP producer gap

Current W2 source hashes:

- `runalith-store/src/lib.rs`: `a08e43b192d02666f8b5956fa8122bd6acaf996524160c4414d5870e49ffe3e3`
- `runalith-control-api/src/lib.rs`: `9044441a6fab7e15a7953d39ba2b36acacca9af7a98b7929f51cf867477bb0ce`
- `runalith-control-api/src/main.rs`: `aea660103453d9f533cac1c71c8a2bead311dc894064de2bc15d760a7f4e31a4`

Store's current `TaskLeaseRenewalRequest` fields are `renewal_id, workflow_id, task_id, lease_id, worker_id, attempt, owner_epoch, lease_ttl_seconds`; its `TaskLeaseRenewal` receipt fields are `renewal_id, workflow_id, task_id, lease_id, worker_id, attempt, owner_epoch, previous_expires_at, expires_at, renewed_at`. Targeted tests pass:

- `lease_renewal_is_atomic_idempotent_and_bound_to_exact_owner_epoch` — 1/1.
- `exact_lease_renewal_receipt_replays_after_store_restart_without_extending_again` — 1/1.
- `lease_renewal_replay_after_expiry_and_quarantine_is_fenced` — 1/1.

Same renewal ID/body can return the original stored receipt for the same currently live RUNNING lease/worker/attempt/epoch. Changed TTL/body conflicts. Stale owner/epoch and expired/quarantined lease are fenced; historical receipt replay after expiry is not unconditional and cannot resurrect an owner.

Current WS3 HTTP prepared request is `{renewal_id, claim, lease_seconds}`; response parser requires exactly ten subject/time fields matching the Store receipt DTO above. But this path is not proven end-to-end:

- `WorkerControlAuthority` remains `Value -> Value`; the HTTP route validates worker/audience/TTL/renewal ID then delegates the entire JSON body.
- `ControlApi::from_store` sets `worker_control=None` unless host injects an authority. Standalone host's worker routes fail closed with 503.
- No concrete Store-backed `WorkerControlAuthority` implementation is proven.
- No authenticated receipt issuer/identity or durable route-to-Store mapping is proven.

Targeted Control API tests pass 1/1 each: `worker_routes_fail_closed_when_authoritative_backend_is_not_configured`; `worker_claim_routes_bind_authenticated_subject_and_capabilities`. They prove fail-closed route behavior and a test authority binding, not a production authority adapter.

There is a real versioned candidate mismatch to resolve explicitly: the separate WS2 `LeaseRenewalV1RequestDraft`/`LeaseRenewalV1ReceiptDraft` carries `schema_version`, `claim_id`, `receipt_id`, `lease_ttl_seconds`, `persisted_at`, `durable`; current Store/WS3 closed ten-field receipt does not. W3 has not received approval for a new renewal DTO or receipt issuer. Do not silently collapse these shapes. WS2 + WS3 must select a successor wire version and publish exact request/response bytes before ratification.

### 1.3 TaskClaim issuer/signing/audience ownership — WS6 confirmation

WS6 A2A seq1301 confirms:

- TaskClaim issuer/claim issuance is a **Control-owned WS2 contract**; WS2 must nominate accountable issuer/host and define claim identity, issuance/idempotency, lease/owner-epoch binding and lifecycle.
- Execution/WS3 owns worker-side consumption and audience/worker identity binding. `TaskClaimVerifier` remains host-injected until an authenticated Execution host contract is approved.
- WS6 owns trust-root/key lifecycle, signing/verifying authority and Governance nonce only after Project Owner/authorized architecture owner plus Host Security appoint the authority and ratify a trust profile.
- No signer, key custodian, issuer identity, audience registry, signing preimage/profile or production verifier is assigned/provisioned. No current approval trust domain is selected for TaskClaim.

Therefore claim authenticator/key authority is `UNASSIGNED / NOT RATIFIED / BLOCKED`. `TaskClaimEnvelopeV4Draft.authenticator` remains fixture-only object data, explicitly not a signature; W3 current payload schema v3 is not a ratified cross-part TaskClaimV1. Fail closed; do not reuse unrelated Governance signer or infer authenticity from golden fixtures.

**Overall CR-03:** local Store renewal idempotency and WS3 client journal retry subparts have passing evidence, but Control HTTP producer/Store adapter, TaskClaim issuer/signer/key/audience authority, exact DTO version, cross-part owner review and deployment are open. `OPEN / BLOCKING / DRAFT_NOT_RATIFIED` remains correct.

## 2. CR-09 WS1–WS7 ↔ WS8 — updated WS2 Common Envelope consumer review

New WS2 review:

- `02-ws8-common-envelope-v1-consumer-review-v2.md` SHA-256 `a5318f3ea32b21dcb36a337fdf12ed2b7daec80b692e50f977f005f1b89a5f71`.
- Reviewed WS8 schema SHA `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2`.
- WS8 Gateway proposal packaged SHA `533b0c24660a9e64a435dc63268df1b848f538bb5762bee1025e492915c9faaf`.

WS2 confirms bounded mapping only: schema major/minor distinct from inner DTO version; mutating command requires outer idempotency key and exact producer receipt; response causation binds exact request message; `producer_id` is metadata not credential; Control principal/audience/effect class derive out-of-band from host-authenticated route; journal `ordering` mapping retains the existing accepted-with-blockers rule in WS8 §4.2. `ordering.predecessor_id` is previous event ID, never previous event hash. If preceding row/history is absent or unverifiable, omit ordering and preserve UNKNOWN/UNRESOLVED.

Remaining blockers: typed W2 request/response/event golden bytes and canonicalization profiles; stable error-code map (current HTTP errors are free-form `{"error":message}` plus numeric status); approved public route registry; authenticated remote peer/principal/audience implementation; exact MCP JSON-RPC request/response/message/causation/idempotency mapping; per-route limits/deadlines; negotiation wired into Gateway dispatch; cross-part signoff. Local Control routes are not automatically public Gateway routes. WS8 requires route ID, owner, service ID, method/path, schema IDs, supported version range, capability, side-effect class, idempotency, body/deadline limits, stable error-map version and compatibility window.

Independent Rust boundary tests run by WS2:

- `cargo test -p runalith-protocol --locked --offline`: **35/35 PASS**.
- `cargo test -p runalith-mcp --locked --offline`: **78/78 PASS** (67 library +6 binary +5 CLI integration).

WS8's own Common Envelope harness records 13/13 structural checks; its standalone version negotiation primitive records 8/8 but is not integrated into Gateway dispatch. These tests prove local structural/service-gateway behavior, not a remotely authenticated Control route or three-deployable integration.

**CR-09 disposition:** bounded ordering and out-of-band principal/audience rules accepted with blockers; complete Common Envelope wire, remote auth, routes, digest profiles and error mapping remain `CHANGES_REQUESTED / OPEN / BLOCKING`. WS8 schema v1.0.0 stays `DRAFT / NOT RATIFIED`; WS8 human owner/integration authority still needs Project Owner assignment.

## 3. V2.3.2 live source verification — WS6 bounded error-attribution evidence

WS6 reviewed V2.3.1 and found its validator pins fixture constants but does not read live source files. V2.3.1 remains unchanged and remains an inventory/fixture validator only. New live checker:

- Fixture `02-control-domain-error-diagnostics-v2.3.2-live-source.fixtures.json` SHA `4c38776fe84d4d4ad8868ab9257beebeb213d5338d45156d4af009dac0ee0a9d`.
- Test `02-control-domain-error-diagnostics-v2.3.2-live-source-test.py` SHA `456dd51137a12a1d6b81a10e055559497639e4fa46a8e3be09591c79441e1ad5`.
- Note `02-control-domain-error-diagnostics-v2.3.2-live-source-note.md` SHA `09ce1f57e871e1541907b33d273bac68c4aefe7defd1c04b1907c3c42b7b061a`.
- Command `python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3.2-live-source-test.py` — PASS.

It verifies exact V2.3.1 fixture/validator bytes; reruns prior inventory validator; computes actual SHA-256 for seven live files. Five match V2.3.1 historical source pins. Exactly two drift: `approval_decision.rs` V2.3.1 `c2a91ac…` vs current `1ef7e309…`; `lib.rs` V2.3.1 `5fba5f3c…` vs current `b980bd06…`. No source files were edited. This is whole-file identity evidence only, not a new code-origin/runtime/authority review or new cause/domain mapping.

## 4. R5.4.2 frozen package identity remains independently verified

- Manifest SHA `a5e49ef7cdc9efe081d3970dbab08d650068e21ce645f9b9651017052cdcb371` (477 entries).
- Archive SHA `f1bfe1215f611157392210cc6f2d1106f3d50f1e1c4f8694fdb1dd95741c86f0` (5,965,956 bytes).
- Verification report SHA `e81d11fd4e036cdc91c18b0f3d27948e8144cd93b6da923775e974c50e138481`.
- Fresh extraction: `EXPORT_INTEGRITY_PASS`, 477/477; 478 regular files including manifest; zero symlinks.

Package integrity does not ratify a producer contract or imply integration/release readiness.

## 5. Owner/action boundary and final status

1. Project Owner assigns WS2 Control implementation owner and approves module/worktree/source scope.
2. Project Owner + Host Security/platform appoint Control claim issuer, signer/key custodian and trust profile; WS6 implements the appointed trust verifier/key lifecycle.
3. WS2 owns TaskClaim issuance/Control producer and stable route/error semantics; WS3 owns authenticated worker consumer/audience and renewal retry client; WS2/WS3 must approve one exact TaskClaim/LeaseRenewal version and golden bytes.
4. WS8 needs an accountable human owner/integration authority; producer workstreams approve their domain mappings before route freeze.

No production source/schema/database/service/deployment/migration file changed. WS3 candidate remains isolated/unmerged. WS8 export was not modified. No commit or push. All new WS2 evidence remains untracked.

**Overall:** CR-02 `OPEN/BLOCKING`; CR-03 renewal retry consumer subpart locally implemented/tested in unmerged WS3 candidate, claim authority and Control producer `BLOCKED`; CR-09 bounded journal-ordering/audience rules accepted with blockers, full envelope/routes/auth/digest/errors `OPEN/BLOCKING`; V2.3.2 live hash check PASS with two explicit source drifts; R5.4.2 package integrity PASS; all contracts `DRAFT_NOT_RATIFIED`; production/release readiness `NOT_PROVEN`.
