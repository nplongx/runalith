# WS2 Control contract candidate — V10.2 reconciliation addendum

**Status:** DRAFT / PROPOSED / NOT RATIFIED.  
**Lineage:** V9 base `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5` + V10 `9fb54a38f1f97f41af6d969d6ec06fc8a779beddcf9128ce0049ffb74375b9e8` + V10.1 `345179cbe3a1affca10f42b8fe5094df971afbed78179857ac6d41a99e01bf97` + this addendum. All earlier files remain byte-for-byte unchanged.  
**Purpose:** record exact WS3 consumer/WS4 provider reconciliation, close a demonstrated fixture schema gap in a new immutable V2 vector, and identify remaining source/authority gaps. This addendum does not authorize source, schema, DB, WorkerStore, route, signer, verifier, migration, deployment, settlement or cutover changes.

## 1. Exact V2 artifacts

| Artifact | SHA-256 | Scope |
|---|---|---|
| `02-control-worker-boundary-v2.md` | `879e840eae61e0cec5316fdbb8e9c444876d3b562be73ecd3e1504a7218d58d5` | Producer/consumer V2 crosswalk and ownership notes. |
| `02-control-worker-boundary-v2.fixtures.json` | `e8ae78f78dbd05f6bb72976a557283d5bd6d90961a11792f8f8b72d40722d07e` | Complete logical claim/fence/renewal and W4 digest crosswalk example. |
| `02-control-worker-boundary-v2-test.py` | `2eb17630c885501f45b2df2dcffbb46374c3a885e63ea1f7579647188ae9f760` | Independent structural/digest/negative validator. |

The V2 fixture supersedes only V1 fixture semantics for V2 review. V1 candidate, V10, V10.1 and V1 fixtures remain immutable historical evidence. V2 is not a signed-byte golden corpus and is not ratified.

## 2. WS3 V2 consumer reconciliation and demonstrated drift

Exact WS3 consumer proposal: `03-execution-fence-v2-consumer-proposal.md`, SHA-256 `efa04fd1440565e221a8b41e39736d7e44f50370c038e4e9f98adfeaddf8fb3c`. Exact current draft validator `draft_contracts.rs`, SHA-256 `a87800f2c897822d9f6c8dd3896bb259ab7fa9b501476bdc6533fdd3ba80e2c2`.

WS3 requires the identical complete subject across:

1. `ExecutionFenceV2RequestDraft` reservation request;
2. `ExecutionFenceV2ReservationReceiptDraft` reservation response;
3. `ExecutionFenceV2CompletionDraft` completion request;
4. `ExecutionFenceV2CompletionReceiptDraft` durable completion receipt.

The exact subject is `schema_version`, claim/workflow/task, first-class `attempt`, lease, worker, owner epoch, plan digest, side-effect ID, kind, request digest, reservation idempotency key and ACL digest. Reservation response additionally has receipt/fence IDs, state, durability and persistence time. Completion request has fence ID, outcome, event ID/event digest/outcome digest. Completion receipt repeats complete subject and outcome/event fields and adds receipt ID, completion digest, durability, terminal flag and persistence time.

### 2.1 V1 fixture defect confirmed

WS3's current draft `parse_fence()` adds `idempotency_key` and `acl_sha256` to the completion request and receipt **in memory**, copying them from reservation request. Its explicit test `ws2_unmodified_completion_fixtures_omit_idempotency_and_acl_subject_fields` asserts both fields are absent from both V1 completion objects and that they fail typed V2 deserialization. That test demonstrated a real producer fixture gap.

WS2 V2 fixes the exact fixture: both fields now appear in both completion request and durable receipt; the full subject is equal at all four lifecycle points. V1 stays unchanged.

WS2 did not edit WS3 code or worktree. The WS3 branch still has its V1 snapshot (SHA-256 identical to WS2 V1 fixture `3f00ee830c292ac1d0baf984a49e30d665ecdde1c0610ae966c955d6cb2e41bd`) and consumer tests. WS2 independently ran against the isolated WS3 worktree:

`CARGO_TARGET_DIR=/tmp/ws2-ws3-consumer-baseline cargo test --manifest-path rust/Cargo.toml -p runalith-worker --locked --offline draft_contracts::tests`

Result: **7 passed, 0 failed**, exit 0. It exercised the existing V1 snapshot plus in-memory completion enrichment and the explicit negative test above. It does not test WS2 V2 fixture or authenticated origin/journal behavior. WS3 must add/update its own V2 snapshot/reference, retain V1 as historical negative/compatibility input, and rerun its tests in its own worktree.

### 2.2 Remaining claim V4 blocker

WS3 V4 `TaskClaimEnvelopeV4Draft` has a typed top-level `acl_sha256`, but its `command` remains generic JSON. WS3 currently verifies `try_command_request()` rejects WS2 fixture command `{kind,payload}` because it is not `runalith_sandbox::CommandRequest`. V2 therefore uses only a non-executable `fixture_command` sentinel. Exact `CommandRequestV1` mapping, canonical signed bytes, duplicate-key rule, nested W4/W5 digest scope and signature/issuer policy remain open. V3 remains byte-compatible and unchanged.

## 3. W2 current producer implementation vs proposed V2

Observed current `runalith-store` code already has first-class `attempt` in `WorkerExecutionFenceRequest` and `WorkerExecutionFenceCompletion`; subject continuity is checked in the Store transaction. However:

- compact reservation receipt JSON currently has fence ID/request digest/durable/recorded time but no typed `receipt_id` and does not repeat full subject;
- compact completion receipt JSON currently has fence ID/event ID/event digest/outcome/completion digest/durable/recorded time/terminal but no typed `receipt_id` and does not repeat full subject, although the surrounding typed record/event contains more detail;
- `TaskLeaseRenewalRequest` has renewal ID/workflow/task/lease/worker/attempt/epoch/TTL but no claim ID;
- `TaskLeaseRenewal` returns renewal ID/subject/previous and new expiry/`renewed_at`, but no claim ID or receipt ID;
- current worker HTTP v1 body is `{renewal_id, claim, lease_seconds}`; current WS3 HTTP client generates a fresh renewal ID each method call and has no durable same-heartbeat retry journal.

These are gaps between the current compatibility implementation and proposed cross-part receipt DTOs, not proof that a production API is available. The standalone Control host still has no configured `WorkerControlAuthority`; worker routes fail closed. No source files were changed to close these gaps.

## 4. W4 Provider Effects V2 digest crosswalk independently checked

WS4 V2 source proposal SHA-256 `f61746825ef15937e33916640a370edad662ebc39cbcae4350abb5cba8951d9b`; exact example SHA-256 `1924d147b9826075fbaf8070417a29c9a05730b52ab12f6cd41919b37a5bb623`.

WS4 `request_binding_sha256` is calculated over provider ID, `account_binding`, workflow/task/claim/attempt/owner epoch/lease/worker/plan/provider idempotency key and provider `payload_sha256`, **excluding nested `control_fence`**. W3 V2/WS2 `request_sha256` must equal that W4 binding. This avoids recursive hashing.

WS2 V2 fixture embeds the exact published W4 request-binding material and recomputes the hash using `runalith-serde-json-value-v1` (compact JSON value bytes with sorted keys):

- W4 request binding = W2/WS3 fence request digest: `4931c987f5d644cdbb499846cb69940429cd3358f052ccb2c9645fd677ae451c`.
- provider payload digest: `6cf23e1c93ff820b7f8c042cd1d29aadb963b90608d7e514f81f73a311541ee3`.
- outer envelope payload digest equals provider payload digest in this single W4 example because both cover the same provider payload object. Do not generalize that equality to a different envelope payload.
- account config digest: `fc2c9fc3530837e8b2d8d4049c52ddf042a514579878031b3be3e64721e1cad4`.

WS2 V2 validator independently recomputed both request binding and provider payload hash; exact results matched W4 example. This is digest crosswalk evidence only. It does not authenticate the nested Control receipt, establish provider origin or ratify the W4 account schema v7 proposal.

## 5. Lease renewal exact-retry proposal

WS3 consumer DTO proposal accepts a caller-owned stable `renewal_id`, complete request body persisted before send, exact same-ID/same-body retries, and full durable receipt with previous/new expiry and claim/attempt/lease/epoch/worker. W2 V2 vectors cover the proposed flattened request and receipt and duplicate exact request/receipt. Structural negative tests cover changed TTL/body under same ID, subject mismatch, stale epoch and non-advancing expiry.

The actual transport crosswalk (nested `claim` + `lease_seconds` vs flattened producer DTO), current Store claim/receipt identity fields and WS3 durable journal ownership still need review. No worker client, Control HTTP route, DB record or retry journal was modified.

## 6. ProcessStop, provider terminality and cancellation

WS3's local `ProcessStopReceiptV1` remains an unsigned local `local_worker_process_tree` observation. It cannot establish provider stop/no-more-side-effects or settle cancellation. WS4 owns `ProviderTerminalProof`; where provider dispatch may have occurred, provider terminal proof remains required. W2 must verify separately approved W3/WS4 evidence and perform authoritative settlement CAS under the current exact fence.

WS6's authority answer remains: WS2 owns ControlFence issuer/receipt/CAS; WS3 owns WorkerStore consumer and process/cgroup facts; WS4 owns provider terminal facts. WS6 may define a distinct verifier policy only after Project Owner assigns a dedicated Control service trust identity/domain/scope/trust-root lifecycle. A separate ProcessStop signing authority owner must be named. Do not reuse GovernanceApprovalReceipt, add a sixth trust domain, release on ACK/timeout/local exit or use receipt SHA as authentication.

## 7. Error diagnostics and WS8 transport

The current WS2 diagnostic fixture preserves `domain_code` and specific WS6 `cause_code` separately. Its validator covers invalid signature/issuer, identity unauthorized, binding/digest/trust snapshot mismatch, trust high-water/revocation/expiry, nonce conflict and nonce ledger unavailable. `AUTHORITY_UNAVAILABLE` must not erase `cause_code`; nonce rebinding is non-retryable `IDEMPOTENCY_CONFLICT`; a valid signed `Rejected` receipt remains a domain decision and never grants admission.

WS8 accepted fixture-level `domain_code` pairing with blockers but has not reviewed the later `domain_code` + `cause_code` fields together. WS2 review request is pending. No HTTP status, retryability, route or envelope field ratified. Outer envelope major/minor version remains distinct from inner claim/fence/renewal schema version.

## 8. V2 validator evidence and limits

`python3 -B rust/workstreams/02-control-worker-boundary-v2-test.py` result:

- positive: TaskClaim V4 top-level ACL/claim binding;
- positive: complete V2 fence subject across reservation request/receipt and completion request/receipt;
- positive: exact reservation/completion replay receipt identity;
- positive: LeaseRenewal V1 full receipt and exact-body replay;
- positive: independent W4 request-binding and payload digest recomputation;
- **26 structural negative mutations PASS** for missing fields, subject drift, changed idempotency bodies, replay receipt changes, partial receipt, UNKNOWN terminalization, provider binding/account drift;
- 4 authority/crypto/compatibility/settlement cases explicitly **NOT RUN**.

No signature verifier, production authority, WorkerStore journal, Control Store transaction, HTTP/API, cancellation settlement or deployment was exercised. V2 remains DRAFT / NOT RATIFIED.

## 9. Release gates and owner boundaries

- WS2 accountable human owner remains UNASSIGNED. WS2 owns Control producer/receipt/CAS semantics.
- WS3 owns Worker V4 parser, V2 fence consumer DTO and WorkerStore V1 compatibility. WS3 must integrate the V2 snapshot and publish canonical consumer test evidence; no WS3 source file edited by WS2.
- WS4 owns provider account/intent/terminal facts and its durable schema proposal.
- WS6 owns trust-root/key/verifier policy only after Project Owner appoints a distinct Control service identity/domain/scope/root and ProcessStop signing authority. Production nonce persistence owner and Control projection transaction/freshness fence remain unassigned.
- WS8 owns common envelope and transport; cause-code review pending.
- WS7 reciprocal review remains blocked by ACL. WS2 must route WS7's response through an allowed WS6/WS8 edge; no ACL change.
- Project Owner must decide D-01 supersession, accountable WS2/host authority owners, Control identity/issuer/root, durable nonce boundary, Control projection ACK/transaction, ProcessStop signer and source/worktree ownership.

No source, Store, WorkerStore, schema, route, key, signer, migration, DB split, production dispatch, settlement, deployment or cutover is authorized. Three deployables/eight workstreams remain unchanged.
