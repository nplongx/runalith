# WS2 Control / Worker producer boundary v2 — DRAFT

**Status:** DRAFT / NOT RATIFIED / NOT CRYPTO GOLDEN.  
**Base:** V9 producer candidate SHA-256 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5`; V10 addendum `9fb54a38f1f97f41af6d969d6ec06fc8a779beddcf9128ce0049ffb74375b9e8`; V10.1 addendum `345179cbe3a1affca10f42b8fe5094df971afbed78179857ac6d41a99e01bf97`.

V2 is an immutable successor proposal. It does not change V9/V10/V10.1 or authorize Rust source, Control Store, WorkerStore, schema, route, signer, verifier, migration, deployment, settlement or cutover changes.

## 1. Exact reconciliation sources

| Producer/consumer artifact | SHA-256 | Review/use |
|---|---|---|
| WS3 `03-execution-fence-v2-consumer-proposal.md` | `efa04fd1440565e221a8b41e39736d7e44f50370c038e4e9f98adfeaddf8fb3c` | Defines immutable attempt-bearing subject, receipts, V1 journal policy and W4 digest crosswalk. |
| WS3 draft consumer validator `draft_contracts.rs` | `a87800f2c897822d9f6c8dd3896bb259ab7fa9b501476bdc6533fdd3ba80e2c2` | Draft-only logical validators; no signer, authenticated receipt verifier, network or durable WorkerStore implementation. |
| WS3 V1 snapshot of W2 fixture | `3f00ee830c292ac1d0baf984a49e30d665ecdde1c0610ae966c955d6cb2e41bd` | Byte-identical copy of WS2 V1 fixture. |
| WS3 `03-json-value-differential-vectors-v1.json` | `8a9428b1eed5315499247bb08ff74bf5f2f1d016eea826221a204ed7ef70f637` | Consumer-local JSON-value hash vectors. |
| WS4 V2 proposal | `f61746825ef15937e33916640a370edad662ebc39cbcae4350abb5cba8951d9b` | Provider account binding and request-binding scope. |
| WS4 V2 example | `1924d147b9826075fbaf8070417a29c9a05730b52ab12f6cd41919b37a5bb623` | Exact provider request-binding and payload digests. |
| WS4 V2 schema/test | `62982ecba995a4e49a8de4ef4ab713f04a5140f57db1619dc002b69981d9d117` / `0dbcd2441c65d07cbfb2a149c8c644826dea4d03d3985b20c933f24286483ec6` | Producer-owned schema and validator; not Control/Worker integration. |
| WS8 common envelope v1 schema | `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2` | Outer transport schema snapshot, still DRAFT. |
| WS6 Governance receipt verifier | `d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09` | Test-only OS-process nonce concurrency update; WS2 independently reran 75/75. |

## 2. TaskClaimV1 / TaskClaimEnvelopeV4

The cross-part semantic contract remains named `TaskClaimV1`; proposed Worker inner payload is `schema_version=4`. The V4 logical payload has:

`claim_id`, `issuer`, `audience`, `issued_at`, `expires_at`, issuance `idempotency_key`, `workflow_id`, `task_id`, positive `attempt`, positive `owner_epoch`, `lease_id`, `worker_id`, `plan_sha256`, `command_sha256`, explicit top-level `acl_sha256`, exact `command`, optional exact `provider_dispatch`, `session_messages`, and an opaque authenticator envelope.

V3 byte/verification semantics remain unchanged. V4 cannot be parsed as V3; do not infer the typed ACL digest from a V3 opaque `authenticator` object. V4 claim subject bytes must bind the complete typed subject, including top-level `acl_sha256`; the authenticator is not included recursively in its own preimage. Exact canonicalization, duplicate-key behavior, signature algorithm/preimage, issuer, audience and key lifecycle remain unapproved. The fixture's `fixture_only` authenticator and `NOT_A_SIGNATURE` marker are intentionally invalid as authority.

**Still blocked:** WS3's `TaskClaimEnvelopeV4Draft.command` is generic JSON because the W2 fixture command `{kind,payload}` does not deserialize into Worker `runalith_sandbox::CommandRequest`. WS3's `try_command_request()` currently rejects this fixture. Exact `CommandRequestV1` field mapping and signed-byte vectors are not published. Do not execute or describe this fixture command as an implementable worker command.

## 3. ExecutionFenceV2 — one immutable subject for four messages

`ExecutionFenceV2Subject` must be byte/field-identical across reservation request, reservation response, completion request and durable completion receipt. Exact field set:

`schema_version=2`, `claim_id`, `workflow_id`, `task_id`, `attempt`, `lease_id`, `worker_id`, `owner_epoch`, `plan_sha256`, `side_effect_id`, `kind`, `request_sha256`, `idempotency_key`, `acl_sha256`.

`attempt` and `owner_epoch` are positive and copied from the authenticated claim/current Control lease. Each digest is its own domain; never substitute `plan_sha256`, `command_sha256`, `acl_sha256`, `request_sha256`, `event_sha256`, `outcome_sha256`, `completion_sha256`, provider payload hash or outer envelope payload digest for another.

### Reservation request

Contains the complete subject. `idempotency_key` identifies the reservation, not provider dispatch. A changed body or subject under the same reservation idempotency identity conflicts.

### Reservation response / receipt

Contains `receipt_id`, `fence_id`, the complete identical subject, `state=RESERVED`, `durable=true`, and `persisted_at`. The consumer checks every field and does not treat an object shape or receipt hash as authenticated origin.

### Completion request

Contains `fence_id`, the complete same subject including `idempotency_key` and `acl_sha256`, exact `outcome`, `event_id`, `event_sha256`, and `outcome_sha256`.

### Durable completion receipt

Contains `receipt_id`, `fence_id`, the complete same subject, echoed outcome and event identity/digests, `completion_sha256`, `durable`, `terminal`, and `persisted_at`. No receipt may be detached/rebound to another attempt, epoch, lease, worker, plan, effect, request digest, ACL or reservation.

`UNKNOWN` and non-verified `NOT_STARTED` remain durable observations with `terminal=false`; they do not release the reservation or owner fence. A terminal `SUCCEEDED`, `FAILED` or verified `NOT_STARTED` needs the separately approved proof verifier inside the authoritative Control transaction. Hash integrity is not proof of process/provider terminality.

### Concrete V1 fixture drift found and fixed in V2

WS3 consumer test source `draft_contracts.rs` explicitly enriches the V1 completion request/receipt in memory by copying `idempotency_key` and `acl_sha256` from the reservation request. A separate test asserts the unmodified WS2 V1 completion request/receipt omit both fields and fail typed V2 deserialization. This is a real schema mismatch, not an inferred concern.

V1 is immutable. The new V2 fixture carries both fields in **both** completion request and completion receipt, and validates complete equality through all four fence messages. No production Store/receipt implementation is claimed.

## 4. LeaseRenewalV1

Renewal is a separate Control operation, not an execution fence. Proposed request:

`schema_version=1`, `renewal_id`, `claim_id`, `workflow_id`, `task_id`, `attempt`, `lease_id`, `worker_id`, `owner_epoch`, `lease_ttl_seconds`.

Proposed durable receipt repeats the exact request subject and TTL, plus `receipt_id`, `previous_expires_at`, `expires_at`, `persisted_at`, and `durable=true`.

For one logical heartbeat, persist the request ID/body before first send. Exact retries use the same ID and identical request bytes and return the same receipt ID and original expiry. A new heartbeat has a new ID. Reusing an ID with changed body/subject is `IDEMPOTENCY_CONFLICT`; expired/stale owner is rejected; renewal never revives an old lease.

**Observed implementation gap:** current `TaskLeaseRenewalRequest` lacks `claim_id`; current `TaskLeaseRenewal` lacks `claim_id`/`receipt_id` (it returns `renewed_at`). The worker-facing HTTP v1 body remains `{renewal_id, claim, lease_seconds}`. WS3 `HttpControlPlane::renew_lease` generates a fresh UUID per call and has no same-heartbeat durable retry journal. The WS2 V2 fixture defines the desired logical DTO/receipt only; it does not claim these mappings are implemented. A versioned transport mapping, W3 durable request journal and W2 durable receipt field/ID mapping require owner review.

## 5. WS4 provider V2 digest crosswalk

WS4 V2 binds non-secret provider `account_binding` (`provider_account_id`, `config_version`, `config_sha256`) and first-class `attempt`.

`request_binding_sha256` is the JSON-value digest of the exact provider subject fields (provider ID, account binding, workflow/task/claim/attempt/epoch/lease/worker/plan/provider idempotency key and provider `payload_sha256`) **excluding nested `control_fence`**. This avoids recursive hashing. W2/WS3 provider-dispatch fence `request_sha256` must equal that W4 `request_binding_sha256`; W4 must recompute from its durable ProviderIntent and immutable account/config snapshot before dispatch.

For WS4's exact checked example:

- W4 request binding / WS2 fence request digest: `4931c987f5d644cdbb499846cb69940429cd3358f052ccb2c9645fd677ae451c`.
- Provider payload digest: `6cf23e1c93ff820b7f8c042cd1d29aadb963b90608d7e514f81f73a311541ee3`.
- W8 outer payload digest: same `6cf23e1c...` in this particular example because the envelope payload is exactly the provider payload object; this is not a general equality rule.
- W4 config digest: `fc2c9fc3530837e8b2d8d4049c52ddf042a514579878031b3be3e64721e1cad4`.

WS2 independently recomputed W4's `request_binding_sha256` and provider payload hash from the exact published JSON value fields using the `runalith-serde-json-value-v1` sorted-map/compact JSON profile; both matched the source example. This is a logical digest crosswalk test, not a signature or provider-origin proof. Keep `authentication_state=UNRESOLVED` until approved Control receipt verification exists. W4's account binding/durable schema v7 proposal remains W4-owned and DRAFT; do not backfill or dispatch legacy unbound v6 intents.

## 6. Process stop, provider terminality and cancellation settlement

- W3 `ProcessStopReceiptV1` remains unsigned local `local_worker_process_tree` observation (`linux_cgroup_v2_populated_zero`). It says local cgroup population was observed as zero at a time; it does not prove provider terminality or absence of further external effects.
- WS3 owns process/cgroup facts and consumer; WS2 owns ControlFence issuer/receipt/settlement CAS; WS4 owns provider account/run/terminal truth and `ProviderTerminalProof`; WS6 may define a distinct trust verifier only after Project Owner assigns Control service identity/domain/scope/root lifecycle and a host ProcessStop signing authority is named.
- Do not reuse `GovernanceApprovalReceipt`, do not create a sixth trust domain, and do not treat local exit, request ACK, timeout, receipt hash or local process stop as cancellation settlement.
- If provider dispatch may have occurred, W4 terminal proof is required as well as applicable W3 stop evidence; Control must verify authority and commit the exact terminal settlement under one current fence/CAS. Until all authority and evidence gates pass, state remains `UNKNOWN`/`UNRESOLVED`; do not release the lease.

## 7. V1 WorkerStore compatibility

WS3 reports WorkerStore v7 stores V1 fence JSON in `execution_fence_request_json` / `execution_fence_json`; V1 request/response/completion structs have no first-class `attempt`. V2 requires a journal discriminator + dual decoder or approved separate V2 journal column/schema. V1 rows remain historical V1 evidence. Never synthesize attempt from request digest or current host config. Nonterminal V1 rows lacking exact authenticated subject/account bindings stay quarantined `UNKNOWN`/`UNRESOLVED`; no new provider dispatch/replay/account lookup. Any WorkerStore migration belongs to WS3 and requires explicit owner/Project Owner approval.

## 8. Stable errors and transport preservation

WS2 owns exact producer `domain_code` meaning; `cause_code` preserves precise verifier diagnostics and must not be flattened into broad domain/transport categories. WS6 diagnostic fixture covers signature/issuer invalidity, identity unauthorized, subject/digest/trust snapshot mismatch, trust-config high-water missing/rollback, revoked/expired trust, nonce conflict and nonce ledger unavailable. A valid signed `Rejected` remains a domain decision and never authorizes admission.

WS8 has accepted only fixture-level pairing for `domain_code`; its V10.1 response preserves domain codes and does not freeze HTTP status/retry behavior. The later W2 `domain_code` + `cause_code` transport review remains pending. Outer envelope major/minor negotiation is distinct from inner TaskClaim/Fence/Renewal schema version. Preserve exact producer diagnostic codes; no retry, auth, terminal or `NOT_SENT` meaning may be invented by transport.

## 9. Ordering and idempotency boundaries

- `expected_prior_sequence` and `expected_prior_head_sha256` are pre-commit CAS inputs, not output event sequence fields.
- `event_seq` and `predecessor_id` are committed journal outputs. `previous_sha256` and resulting `sha256` are separate digest-chain fields.
- No W3 producer sequence is invented from timestamps or UUIDs. Incomplete history remains `UNKNOWN`/`UNRESOLVED`.
- Stable reservation, renewal and completion event identities are distinct. Exact duplicate returns original durable receipt; changed content under same identity conflicts. Ambiguous mutations are reconciled, not automatically retried.
- W8 envelope `message_id` and `payload_digest` are distinct from inner W2 event/renewal/receipt identity and all request/subject digests.

## 10. Executable evidence and explicit limits

V2 fixture: `02-control-worker-boundary-v2.fixtures.json`, SHA-256 `e8ae78f78dbd05f6bb72976a557283d5bd6d90961a11792f8f8b72d40722d07e`.  
V2 validator: `02-control-worker-boundary-v2-test.py`, SHA-256 `2eb17630c885501f45b2df2dcffbb46374c3a885e63ea1f7579647188ae9f760`.

Command `python3 -B rust/workstreams/02-control-worker-boundary-v2-test.py`: **26 structural negative mutations PASS**, alongside positive checks for V4 claim/ACL binding, full V2 fence subject continuity, reservation/completion exact-replay identities, LeaseRenewalV1 stable exact-body replay, and independently recomputed W4 request/payload digest crosswalk.

Four negative domains are deliberately NOT RUN by this validator: unavailable production authority, invalid cryptographic signature, legacy WorkerStore journal compatibility and ProcessStop/provider cancellation settlement. The test does not call `runalith-store`, `runalith-control-api`, the WorkerStore journal, a production signer/verifier, HTTP route, or DB transaction. It is not an implementation, cryptographic golden corpus, migration test, integration acceptance or ratification.

WS3's current draft consumer module was independently exercised on its isolated worktree using `CARGO_TARGET_DIR=/tmp/ws2-ws3-consumer-baseline cargo test --manifest-path rust/Cargo.toml -p runalith-worker --locked --offline draft_contracts::tests`: **7 passed, 0 failed**, exit 0. This was against its V1 fixture snapshot and draft-only validator, including an explicit assertion for the two missing completion fields; it does not yet exercise this V2 fixture or prove production authentication/journal behavior. WS3 owns its snapshot update and must rerun the consumer tests against the V2 snapshot.

## 11. Owner split / release gates

- WS2: Control producer DTO/receipt semantics, exact renewal identity/receipt, fence issuer/receipt and authoritative completion/cancellation CAS.
- WS3: Worker V4 parser/consumer, V2 fence DTO, renewal exact-retry journal, WorkerStore V1 compatibility and local process/cgroup observation. No W2 edit of WS3 files.
- WS4: provider account binding, provider dispatch/run and terminal proof.
- WS6: trust-root/key/verifier policy only after Project Owner assigns separate Control identity/domain/scope/root and host signer authority; no implied reuse of Governance approval domain.
- WS8: common envelope/wire schema, transport projection and cause-code preservation; no producer domain semantics or status/retry invention.
- Project Owner: accountable human WS2 owner, ControlFence identity/issuer/signing-root and nonce authority, ProcessStop signer owner, durable nonce persistence, Control projection transaction/freshness fence, D-01 supersession, source/worktree ownership and migration boundary.

Until those decisions and canonical signed-byte vectors arrive: keep all V2 contracts DRAFT; no source implementation, WorkerStore/Control Store migration, signer/key provisioning, production route/dispatch, cancellation settlement, D-01 database split, deployment or cutover.
