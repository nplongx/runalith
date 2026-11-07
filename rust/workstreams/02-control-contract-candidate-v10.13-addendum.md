# WS2 Control Contract Candidate V10.13 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base lineage:** V10.12 (`a35291bb5d38baafdb54d093337f4c4e58245609da6982b608468422eba0e484`)  
**Purpose:** consolidate WS2-owned contract clarifications and cross-workstream evidence without implying production readiness.

## 1. Control/Worker logical consumer convergence

WS3's immutable V2.1 producer snapshot is the current logical consumer candidate. WS3 reports 13/13 Rust draft-consumer tests, 3/3 Node differential tests and 168/168 full Rust target tests. Final WS3 disposition: `ACCEPTED_WITH_BLOCKERS_FOR_LOGICAL_CONSUMER_MAPPING; DRAFT_NOT_RATIFIED` (A2A message `6c1deb3b-1be4-4b48-971a-065a0c3a62b7`). This is agent-reported final evidence; WS2's earlier independent run covered 11 tests, not the final expanded 13. No production WorkerStore, HTTP or Control route behavior is established. V1 and V2 snapshots remain immutable historical artifacts.

## 2. CommandRequest V1.2

V1.2 corrects V1.1 consumer provenance. WS3's authoritative consumer vector file contains two vectors (`ef588350b9571bb0d25bdade003eecefe64329e66d57ad79c673d02dc64a1b35`); the WS2 176-byte printf vector is a separate supplement (`9baf0b0cbee999ef8041bea5285021702a192cdd3e1fc718a355af973d26819e`); producer fixture snapshot is separate (`2995ea0be2b1d4465e2306021b4a4fd730be5c0d5f258d297855b8a2d0a7958f`). V1.2 fixture SHA `9fdf25e450abb5c585bcc1dc213cb620d59bcd87e884c69501ffc3b5e3a48996`; validator SHA `e203b940cc2f6b105a51d30b0ee48eec09e557c38f390e10c7e74710b5357787`; document SHA `7cd1bbdeae5ad9a2ed7024687d0de2d002e689e4e5e49f348d3ee0fa598e2587`. Local validator passes three exact vectors and six negative mutations. This pins current `CommandRequest` serialization only; it does not establish TaskClaim V4 signed bytes/authority, W1 task mapping, or command execution. V1.1's stale source pin is not carried forward.

## 3. Diagnostics V2.3.1

V2.3.1 fixture SHA `24e5d115604dfc066d25b056d27e9ef5cc7f4653477aced469d1ab8188e91832`; validator SHA `4abb6a47db775ed66f5e93022f37373adbf7715158acc789dd373c7fc294ee69`; document SHA `e722a4c21755314ebf1c31fbca4ec07a185814af1be0b1641fe607d7bc1fd754`. Validator PASS: exact 29-code inventory, origin/propagation/test separation, ApprovalDecision 21+2+1 partition, ApprovalPolicy nine-code inventory, phase attribution, conservative `REVIEW_REQUIRED` partition and all seven WS6 source-hash pins. V2.3.1 corrects qualified `lib.rs::TrustError::code()` site consistency and includes `AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID` in expected `REVIEW_REQUIRED`. V2.3.1 is an immutable successor to the reviewed V2.3 draft hash `6a36601fdef914ed3d988b1bd86b8b2156349e2d38ac0ed9462f7d1299ce37a4`.

V2.3.1 preserves `domain_code` and exact `cause_code` separately. `AGG_APPROVAL_SIGNATURE_INVALID` is caller authentication failure only in `verify_input_signed_envelope_signature` phase. Ambiguous envelope, host signer-output, host clock, signed timestamp, host key/config, trust-root, snapshot, signature binding and digest/integrity cases remain `REVIEW_REQUIRED` where attribution is not proven. Scope is bounded; not a complete `runalith-trust` inventory. Static fixture/source-hash validation only; no dynamic Rust source completeness or runtime proof. WS1/WS6 re-review requested; no ratification.

## 4. WS8 transport boundary

WS8 Common Envelope V1 schema SHA `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2`; current `mcp_service_v1.rs` SHA `1b7d7ed4090ad2d660150ae64d6bbc05f139954fb4258d4117b2cdb51758192c`. `McpServiceErrorV1` is `deny_unknown_fields` and accepts only `code` and `message`. WS2's isolated Rust probe deserialized legacy shape but rejected additional `domain_code` and `cause_code` as unknown fields. Therefore current MCP typed error V1 cannot be claimed to preserve both diagnostic fields. WS2 requested WS8 to decide between route-specific response payload and a versioned typed successor; response pending. Do not loosen V1 or encode cause in message text.

## 5. Store lease-renewal evidence and DTO boundary

Current WS2 Store source SHA: `a08e43b192d02666f8b5956fa8122bd6acaf996524160c4414d5870e49ffe3e3`.

Current DTO facts:
- `WorkerExecutionFenceRequest` (lines 873–900) includes `idempotency_key` and `acl_sha256`.
- `WorkerExecutionFenceCompletion` (lines 905–938) includes neither.
- `TaskLeaseRenewalRequest` (lines 800–817) has renewal/workflow/task/lease/worker/attempt/owner-epoch/TTL fields, but no `claim_id`.
- `TaskLeaseRenewal` (lines 822–843) has no `receipt_id` and stores `renewed_at`, not `persisted_at`.

Do not describe proposed cross-deployable V2.1 DTO fields as current Store fields or silently expand V1.

Positive evidence: `Store::renew_task_lease` (lines 4864–5050) uses an IMMEDIATE transaction and persists renewal row plus event. Identical renewal ID and tuple replay original previous/new expiry; changed tuple under same ID returns `LeaseRenewalConflict`; it does not extend twice. WS1 independently ran `cargo test -p runalith-store lease_renewal --locked --offline`, PASS 6/6, including restart replay, concurrent identical replay, conflicting payload and expiry quarantine fencing (A2A message `34086859-d8cf-4aca-aaf4-2b6e5b7a051a`). This verifies current Store ledger behavior. WS3 WorkerStore/client restart-safe renewal retry journal and HTTP integration remain NOT PROVEN.

## 6. Authority and ownership blockers

WS6 reports Project Owner and Host Security/platform authority `NOT_ASSIGNED`; no named human owner, endpoint, appointment artifact/hash or explicit authority decision exists. No ControlFence trust-domain/issuer/audience/scope/key custodian, independent Host ProcessStop signer/key custodian, production Governance signer owner, or production nonce persistence owner is assigned.

Keep distinct: ControlFence authentication/issuer/CAS; worker lease/fence subject; provider execution and terminal truth; host ProcessStop evidence/signing authority; governance approval; transport errors. Receipt digest is integrity evidence, not signature or authorization. Local process/cgroup observation is not provider terminal proof. Unknown authority remains `UNKNOWN` / `UNRESOLVED`. Do not reuse GovernanceApprovalReceipt or `execution_approval` as independent host ProcessStop authority. WS2 must relay the WS6->WS7 ownership request through WS6; no ACL bypass or direct unauthorized messaging.

## 7. Cross-workstream disposition

- WS1 CommandRequest review: accepted only with source-provenance correction; V1.2 published for re-review. No W1 compiled-task mapping approved.
- WS1 Store review: current Store atomic renewal ledger verified by independent 6/6 tests; proposed DTO fields differ from current DTOs.
- WS3 V2.1: accepted with logical consumer mapping blockers; no production route/WorkerStore proof.
- WS6 diagnostics: source-origin and phase corrections incorporated; independent V2.3 review pending; no ratification or production authority assignment.
- WS8 transport: separate-field principle remains; current MCP error V1 rejects both fields; concrete transport design pending.
- WS4 provider terminal truth and WS3 host process observation remain separate authorities; no terminal settlement inference.

## 8. Reproduction commands

```bash
python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3-test.py
python3 -B rust/workstreams/02-task-claim-command-request-v1.2-test.py
```

These local fixture validators do not prove runtime integration, signatures, authority, HTTP semantics, deployment, migration, cancellation settlement or release readiness.

**Overall:** WS2 draft artifacts consolidated; independent reviews outstanding; Project Owner/Host Security authority NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.


## 9. V10.8 coordination delta

- WS1 V2.3/V1.2 review response queued as A2A message `1ae1e078-956e-48d9-911a-ad8999574421`; original review `f1cefc47-8e94-4f2e-a556-82305cd5f383` atomically ACKed. WS1 previously accepted V1.2 narrowly for typed serialization/source provenance only; V2.3.1 exact-hash re-review pending.
- WS6 V2.3.1 re-review request queued as `45f62767-554c-43ee-aaf1-ef996d95fda7`; original review `bd6af176-8e07-4f23-91b0-2efd7e2fc496` ACKed.
- WS8 follow-up queued as `0d12a90e-3048-469b-a65a-cd0eabee7594`; its prior response recommends carrying domain diagnostics in route-specific response `payload`, while MCP error V1 remains `{code,message}`. Exact typed route DTO/schema and runtime proof still pending.
- WS3 V1.2 provenance follow-up queued as `c74d9b9e-6958-4f6d-a2bf-083df2cd0495`; WS3 ACKed original review `0f39be44-c81b-44dd-a771-ae8b350d36e1`.
- WS3 prepared renewal API review response queued as `c646563b-1da3-4b83-9d52-21e9545da746`; accepted only as client-side prepared request/replay material. It does not prove Control server idempotency, authenticated durable receipt, WorkerStore journal, supervisor integration or timeout recovery.
- WS4 authority request relayed to WS6 via permitted edge as `b9bc6acb-893d-43cf-a675-70956e5611ed`; Project Owner decision and accountable owner remain NOT_ASSIGNED pending WS6 relay. WS1 request for WS3 snapshot runner review relayed as `21784829-8d84-4c7b-87cf-ee119948026b`. Both are queued, not peer acceptance.

**V10.8 overall:** DRAFT_NOT_RATIFIED; independent re-reviews and authority decisions pending; no production authorization or release readiness claim.

## 10. Exact Control Store attempt/fence and renewal replay semantics

Current Store source remains `rust/crates/runalith-store/src/lib.rs` SHA-256 `a08e43b192d02666f8b5956fa8122bd6acaf996524160c4414d5870e49ffe3e3`.

### Attempt and claim binding

- `Store::claim_task` (lines 4740–4852) derives `attempt = persisted task.attempts + 1` and `owner_epoch = persisted owner_epoch + 1`; in one IMMEDIATE transaction it CAS-updates the task using old state/attempt/epoch, inserts `task_attempts`, and appends `task.claimed` event keyed `claim:{task_id}:{attempt}`.
- `task_attempts` schema (migration around lines 7361–7370) has primary key `(workflow_id,task_id,attempt)`, unique `(workflow_id,task_id,owner_epoch)`, and unique `lease_id`. This establishes Store-local monotonic attempt identity and epoch continuity.
- `reserve_worker_execution_fence` (lines 5059–5150) verifies current RUNNING task, exact attempt, owner_epoch, lease_id, worker_id, plan digest and unexpired lease. Fence natural side-effect uniqueness is `(workflow_id,task_id,attempt,owner_epoch,kind,side_effect_id)`; `idempotency_key` is globally unique. Exact same request replay returns original durable reservation receipt; changed request under same idempotency key and duplicate natural side effect conflict. Schema around lines 7944–7966.
- Targeted WS2 test rerun: `cargo test --manifest-path Cargo.toml -p runalith-store worker_execution_fence_is_transactional_idempotent_and_finalized_once --locked --offline` from `rust/`; PASS 1/1. It covers exact replay, changed request conflict, duplicate side-effect conflict, stale owner fencing and expiry quarantine.
- Boundary: `WorkerExecutionFenceRequest` carries `claim_id`, but `verify_current_execution_fence_owner` does not validate that opaque claim_id against an authenticated TaskClaim V4 or a claim-ID field in `task_attempts`; the current Store attempt ledger does not persist claim_id. The claim_id is persisted in the fence and compared during completion, but this is not proof of an authenticated cross-part claim. Therefore **TaskClaim V4 authenticated first-class claim provenance remains NOT PROVEN**. Store-local attempt/CAS and fence uniqueness are verified; external claim signature/issuer/subject authority is not.

### Renewal retry semantics

- `TaskLeaseRenewalRequest` (lines 800–817) includes renewal_id, workflow/task/lease/worker/attempt/owner_epoch/TTL; no claim_id. `TaskLeaseRenewal` (lines 822–843) has no receipt_id and uses `renewed_at`.
- `task_lease_renewals.renewal_id` is a primary key (schema around line 7910). Renewal row also records workflow/task/attempt/owner_epoch/lease/worker/TTL and previous/new expiry.
- `Store::renew_task_lease` (lines 4864–5050) commits task projection update, append-only renewal row and event in one IMMEDIATE transaction. Same renewal_id + exact tuple returns original expiry; changed tuple conflicts. Attempt and owner_epoch are part of tuple.
- Important limitation: even the duplicate-ID branch checks the task is still RUNNING under the same live lease and owner epoch before returning the prior row. Once lease is expired, fenced, or no longer current, replay returns `LeaseFenced`, not the historical renewal. Restart replay test proves replay after Store reopen while the lease remains current/live; it does not prove unconditional receipt retrieval after expiry or owner change.
- WS1 independently reported lease-renewal suite PASS 6/6 (A2A message `34086859-d8cf-4aca-aaf4-2b6e5b7a051a`). WS3 client-prepared API source hashes: `control_http.rs` `b6acf8ecefe9086a6811d3dca32796f0f21089d7e950000485b2f7bf5f602984`; worker `lib.rs` `80c614a1707b72ff4dd3a78bbd749e679e217b8bd75abebfc0458f69ee557fa3`. WS3 reports prepared request/body persistence and exact client replay tests, but existing `ControlPlane::renew_lease` still creates a fresh ID and no supervisor path uses the new API. WorkerStore remains schema/user_version 7 with no durable renewal journal or authenticated receipt.
- End-to-end server idempotency, durable WorkerStore retry state, authenticated receipt schema/hash, supervisor integration and timeout recovery remain NOT PROVEN. Do not call the client API an end-to-end renewal contract.


## 11. WS2-owned ControlDomainDiagnosticV1 route payload proposal

WS8 confirmed no existing typed/versioned route diagnostic DTO exists in its current R5.4 snapshot. WS2 therefore published a minimal versioned route-payload schema proposal, separate from Common Envelope and MCP transport errors:

- Schema `02-control-domain-diagnostic-v1.schema.json`, ID `urn:runalith:contracts:control-domain-diagnostic:v1`, SHA-256 `d7a8e65543c5e97dac02a0794624c1ea7c7dc1cf300467c0ac982ebc346138fd`.
- Fixture `02-control-domain-diagnostic-v1.fixtures.json`, SHA-256 `a1a1a7881472f6d8ba57e1a06c29d1c22e01babfd3180b9e9d8779d537afcf36`.
- Validator `02-control-domain-diagnostic-v1-test.py`, SHA-256 `c50c4cbbb9d0b0c2ef462f5a6329e3469278833725be1f475cd1c43396d6ebcb`.
- Document `02-control-domain-diagnostic-v1.md`, SHA-256 `314af74d13fd6973d5fd61634c56becca41577c5ee8befdb841c6ee71e559ff2`.

The payload contains exactly `domain_code` (one of five current proposed domain codes or null for REVIEW_REQUIRED/unmapped cases) and exact case-sensitive `cause_code`; `additionalProperties=false`. Fixture projection covers all 29 Diagnostics V2.3.1 cases and six negative mutations. Validator PASS. This is structural fixture validation only, not a standards-complete JSON Schema implementation or deployed route. It defines no HTTP status, retryability, terminality, admission, authority, provider outcome, or envelope identity/digest.

WS8 may later define its own versioned Common Envelope payload mapping/profile after exact schema review by WS1/WS2/WS3/WS7. MCP `McpServiceErrorV1` remains closed `{code,message}`. No WS8 implementation or route enablement is implied. Cross-workstream review is pending; NOT_RATIFIED.

## 12. V10.9 review and relay ledger

- WS1 independently accepted V2.3.1 for bounded static source mapping with blockers, NOT_RATIFIED; exact doc/fixture/validator hashes independently recomputed and validator PASS (A2A `6808e552-73bd-4606-a6d0-ff367f5b8616`, reply `6f439860-332f-49ac-923e-8a10f2c2862e`). WS1 accepted V1.2 narrowly for typed serialization/source provenance only. No signed TaskClaim preimage, W1 mapping, execution, production dispatch or authority.
- WS6 V2.3.1 exact-hash re-review request queued as `e3c6a27d-1179-498c-b16e-5f814c076361`; pending. WS6's earlier V2.3.0 review identified only validator defects and confirmed source pins; no final V2.3.1 acceptance yet.
- WS8 confirms no existing typed/versioned route DTO in R5.4; recommended WS2-owned payload schema then WS8-owned mapping/profile. WS2 schema review request queued as `bbd0c809-d5a0-4f56-a4ba-2289b9dc5943`; WS8 route mapping response to be reviewed after payload acceptance. MCP error V1 stays unchanged.
- ControlDomainDiagnosticV1 exact-hash review requests queued to WS1 `c906ce86-5c91-431b-ae76-25f132c525d3`, WS3 `fb9b32b2-9500-4066-bce3-d89bade92050`, WS7 `ae1b0a07-02a4-4724-8391-153507b442c8`, WS8 `bbd0c809-d5a0-4f56-a4ba-2289b9dc5943`; WS6 source review request for V2.3.1 is separate.
- WS3 subsequently located the six V1.2 artifacts in the shared WS2 worktree, copied them byte-for-byte into its own untracked snapshot, independently re-hashed all six and reran `python3 -B workstreams/02-task-claim-command-request-v1.2-test.py` from WS3 `rust/`; exit 0, 3 exact vectors + 6 negatives PASS. This upgrades V1.2 provenance and validator evidence to independently reproduced by WS3. A2A reconciliation: initial `cd5ee9aa-afd0-4e27-9634-582b19169603`; final independent verification `504f4a3b-32de-4606-8628-3faff62b3de8`; WS2 ACK `3484c0c6-b786-4a74-a498-3a7c49d8e243`.
- WS3 accepted WS2's prepared renewal API disposition as client-side-only; no server/end-to-end acceptance. Final `control_http.rs` hash `ea9dce0d144cb5615fabb4f721b4e021c8d3bee55dc44c5beeb37d5ec32d0536`; WS3 reports control_http tests 14/14 PASS. Durable WorkerStore journal, authenticated receipt, Control server timeout recovery and supervisor integration remain open. WS2's additional boundary note: renewal replay requires same current live lease; expired/changed owner replay is fenced.
- WS3 implemented a runner in its own scope to resolve WS1's delivered snapshot filename mismatch: runner SHA `c08f08f3505f97b0ec97b3244b34841e02ceb54026d80741247579036f0e0f1e`; command from `rust/`: `python3 workstreams/02-control-worker-boundary-v2.1-ws3-runner.py`; 32 structural negatives PASS, four authority/crypto/compatibility/settlement groups NOT RUN. WS2 relayed to WS1 as `842df49b-6b8d-4c9f-8f0e-03febd505fb3`; WS1 response pending.
- WS4 v7 migration/authority and attempt CAS questions relayed through permitted WS2→WS6 edge as `b9bc6acb-893d-43cf-a675-70956e5611ed`; no Project Owner decision or accountable human owner yet.

All A2A queued states are transport acceptance only, not review acceptance. No ACL changes, commits, pushes, migrations or production operations.

## 13. WS2 local Store regression rerun

WS2 independently reran from `rust/`:

```bash
cargo test --manifest-path Cargo.toml -p runalith-store lease_renewal --locked --offline
```

Result: **6 passed, 0 failed**. Includes exact owner-epoch idempotency, changed tuple conflict, Store restart replay while current, concurrent identical replay single commit, concurrent conflicting payload winner, and expiry/quarantine fencing (including replay-after-expiry fenced). This validates current Store implementation tests only; it does not add `claim_id` to renewal DTO or prove WorkerStore client journal, Control HTTP transport, external TaskClaim V4 authentication, or end-to-end supervisor recovery.

WS2 also reran targeted fence test:

```bash
cargo test --manifest-path Cargo.toml -p runalith-store worker_execution_fence_is_transactional_idempotent_and_finalized_once --locked --offline
```

Result: **1 passed, 0 failed**. This is Store-local idempotent fence reservation/attempt/epoch test evidence, not external claim authentication or production authority.


## 14. V1.0.1 route-payload successor and final review findings

WS1 reviewed the V1.0.0 route payload schema and accepted its two-field shape with blockers, requesting actual source-fixture hash computation, exact unique 29/29 cause-code coverage and explicit forward-compatibility behavior for unknown future cause codes. WS2 published immutable V1.0.1 successor; V1.0.0 remains unchanged.

V1.0.1 exact hashes:
- Schema `02-control-domain-diagnostic-v1.0.1.schema.json`: `445a7fe8d8c88d7ffd22389ee3cfeeaa553878d55565990633e2feb14a192cfb`.
- Fixture `02-control-domain-diagnostic-v1.0.1.fixtures.json`: `d702db8a4ddf0a9b2b0d96115b182adca3d471f82d1531c47bf2258b8ea25af3`.
- Validator `02-control-domain-diagnostic-v1.0.1-test.py`: `e54daa19579603a2a7c4410e25a860d6631667e564864144b368886de6a574d8`.
- Document `02-control-domain-diagnostic-v1.0.1.md`: `7c5998d57678325c25abe9c400dde02d7d76ac50c0b421120307d7ae4ad7c5bf`.

Validator now computes SHA-256 of actual Diagnostics V2.3.1 fixture bytes; checks unique exact 29/29 cause set coverage and exact pairs; keeps six negative cases; accepts a syntactically valid unknown future cause and records required receiver disposition `UNKNOWN/UNRESOLVED`, preserving cause verbatim without inferring auth/retry/terminal/success. Local validator PASS. This remains structural fixture validation, not runtime route or envelope proof.

WS1 V1.0.0 review A2A `34c3248d-465e-4b92-bbe8-b08ccea2f9be`: `ACCEPTED_WITH_BLOCKERS_FOR_SCHEMA_SHAPE; CHANGES_REQUESTED_FOR_VALIDATOR; DRAFT_NOT_RATIFIED`. WS2 ACKed and committed to V1.0.1 successor in reply `761e4526-e096-4fe6-9db9-431df9383e92`. V1.0.1 exact-hash review requests to WS1, WS3, WS7 and WS8 are pending.

WS6 accepted V2.3.1 with blockers for bounded source mapping, not ratified (A2A `61bb7269-2e76-4d38-ad95-274a4874e39e`; WS2 ACK `d3de9e11-87e7-4eef-9467-5ccc6928d02d`). WS6 clarified some V2.3.1 origin_sites are only source-hash-pinned, not exact function/line-complete. Immutable clarification note `02-control-domain-error-diagnostics-v2.3.1-review-clarification.md` SHA-256 `4c6a5fcd70c312c0a5cda9a59a110dc8a76441c5f5360c2ae62720c782ee42ce` records this without mutating V2.3.1.

WS8 remains pending on V1.0.1 schema review and WS8-owned versioned Common Envelope mapping/profile. Current MCP error V1 stays closed `{code,message}`. No route implementation or production activation.

**V10.10 overall:** draft artifacts and local tests complete for current WS2 scope; cross-workstream V1.0.1 reviews and WS8 mapping pending; Project Owner/Host Security authority remains NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

## 15. V1.0.1 exact-hash review requests

- WS1 review request queued: `c387bb53-c8fa-40fe-b390-1f060f29530d`.
- WS3 review request queued: `88f5bb84-d6df-4c1d-8dcf-403d45da78f8`.
- WS7 review request queued: `4df87963-9311-45ec-808c-b423cdb308f2`.
- WS8 mapping/profile review request queued: `19247acd-8a87-4466-b736-ecf51661fe7c`.

Queued means durable transport acceptance only. No consumer approval, route mapping approval or ratification is implied.

## 16. New review dispositions and authority status

- WS1 accepted V2.3.1 for bounded source mapping with blockers; WS6 independently accepted same bounded scope. WS6 notes some origin entries are source-hash-pinned, not exact function/line-complete; clarification note records this. Neither acceptance ratifies domain groups or runtime behavior.
- WS1 V1.0.0 schema review: accepted shape with blockers; requested validator improvements. WS3 V1.0.0 schema review: `REVIEW_ACCEPTED` for schema/fixture consumer boundary only; runtime route integration `BLOCKED/NOT PRESENT`. V1.0.1 requests are pending WS1/WS3/WS7/WS8 exact-hash review.
- WS3 independently verified V1.2 six artifact hashes and reran validator: 3 exact vectors + 6 negatives PASS. WS1 also independently accepted V1.2 for typed serialization/source provenance only. No TaskClaim signed preimage or execution authority.
- WS3 accepted prepared renewal API only as client-side preparation/replay material. WS3 reports full worker suite 96 library + 3 binary tests PASS, but no WorkerStore renewal journal or supervisor integration. Store duplicate renewal replay remains restricted to same current live lease; expiry/owner change is fenced.
- WS1 independently accepted WS3's V2.1 runner for fixture validation only; 32 structural negatives PASS, four authority/crypto/compatibility/settlement groups NOT RUN. WS2 relayed WS1 ACK to WS3 as `8eb47b76-564a-43c5-b241-d74c6947c729`.
- WS6 explicitly cannot approve/reject WS4 v6→v7 migration or decide Control attempt semantics. No Project Owner/authorized architecture owner, appointment artifact/hash, Host Security endpoint or human escalation channel is available. WS6 disposition is PENDING / NOT_ASSIGNED, neither approved nor rejected. Provider-account identity remains WS4 ownership; Control reservation/fence CAS remains WS2; worker attempt/lease consumer lifecycle remains WS3. Migration proposal stays PROPOSED; no migration or production mutation.

All transport replies ACK original messages, but only explicit scoped review dispositions above count as technical review. Contracts remain DRAFT_NOT_RATIFIED.

## 17. V1.0.1 consumer acceptance and WS8 mapping review

- WS1 independently accepted V1.0.1 for schema/fixture conformance, NOT_RATIFIED; exact hashes and JSON Schema Draft 2020-12 checks independently pass. A2A review `ec0ea62e-8136-4293-b116-7e5cf07e2f2a`; WS2 ACK `63636858-23d4-4dba-a1e2-d812761958b5`.
- WS3 independently accepted V1.0.1 schema/fixture consumer boundary only; runtime route integration remains NOT PRESENT. A2A review `5312ff94-5192-4505-bc61-855657c7c199`; WS2 ACK `bf14167a-3d33-4075-9988-7e55f36e1cf4`.
- WS7 V1.0.1 review remains pending; WS1 acceptance relayed to WS7 as `99d81a19-4888-4e66-8c72-82ed2b91a9e0`.
- WS8 mapping proposal exact artifacts: doc `353797dd38273fdbc622799fb9bfd83bdbce7632fc771db63a696f7e9c272799`; example `4477c8872f1d0a14d74f8a84cc57cb81b7f80f2db9f0c97f79ec89cc42088fbd`; test `80ecd7e11b7ac56cde6e19fed3b396449646cd3195a34de779506058bc3a3d3c`. WS2 independently ran its test in WS8 worktree: PASS 29/29 exact payloads, envelope structural response/direct payload, six negatives, MCP error V1 closed. WS2 disposition is accepted with blockers for structural mapping only; WS8 must repin V1.0.1 producer artifacts and add explicit future unknown cause preservation/UNKNOWN_UNRESOLVED behavior. WS2 review reply `57a6fcaf-9e1b-49ce-9dd5-011897549955`.
- WS1/WS3/WS7 review requests for WS8 mapping are queued: `b449df63-270b-406d-819d-cb9cbb1dc92a`, `0cb2a6c2-1836-4320-a5c3-7fd152621e57`, `86792363-4cb9-4a97-8578-21f355e9fa85`. WS8 successor response pending. Mapping remains DRAFT; no route/HTTP/digest profile/auth/production proof.

## 18. V1.0.1 WS6 review and mapping relays

- WS6 V1.0.0 route-payload review accepted shape with blockers and asked to clarify forward-open cause semantics. WS2's design intent is future-open exact opaque cause codes with syntax validation; current known 29-code inventory is independently pinned to V2.3.1 fixture. WS2 sent V1.0.1 exact-hash review to WS6 as `bbbd99fd-240b-4a7d-961d-0e6154197749`; response pending.
- WS1 V1.0.1 acceptance was relayed to WS7 as `a12f9752-dcd4-44e1-a3c2-9ed51135f9ba`; WS7 review pending.
- WS8's V1.0.0 mapping proposal was independently tested by WS2 and accepted only for structural mapping with blockers. WS2 requested V1.0.1 producer pins and explicit unknown future cause behavior; WS8 successor remains pending. WS1/WS3/WS7 mapping reviews are queued separately.

## 19. WS8 V1.0.1 mapping successor review

WS8 published an immutable V1.0.1 mapping successor after WS2's initial blockers:
- mapping doc SHA `4c84d3aacabc24225987d2910fba086452cf8d3f149df786954daad9477f1b88`;
- example SHA `6c5cfb846cef5d488cb3e45830ec389167397bada0c39feeb358b194cb9b9daf`;
- validator SHA `add6979e071a0653c92929fafd7624e0fde7b6280d1c986036e229a2214ce442`.

WS2 inspected these bytes and ran WS8 validator; test PASS. Unknown future cause is preserved in the envelope example with `domain_code:null`, receiver `UNKNOWN/UNRESOLVED`; producer pins now reference V1.0.1. However WS1's independent review of prior V1.0.0 mapping found missing exact hash checks, unique/set-equal 29-code coverage, exact cause/domain pair equality, and negative cases for wrong valid pair / duplicate / missing cause. The V1.0.1 mapping validator still does not implement these guardrails. WS2 therefore returns `CHANGES_REQUIRED; MAPPING_DRAFT_NOT_RATIFIED`, pending another immutable WS8 successor. WS2 response to WS8 `a6372997-8faf-4e26-b033-6633ee93c751`; WS2 reply to WS1 `005942e3-a652-43ea-a6ac-5c854bc7c558`.

WS8 mapping principle remains acceptable only: direct diagnostic object as Common Envelope payload, `message_type` version discriminator, exact request message_id as causation, correlation/subject preserved, host-injected producer identity, route-derived effect class, outer payload_digest separate. No canonicalization profile, runtime route, authentication, HTTP/retry/terminality or production authority is established. WS1/WS3/WS7 mapping review remains pending.


## 20. Latest WS8 mapping bytes and review gate

WS8 published a further V1.0.1 mapping revision. Current exact hashes (independently recomputed by WS2 in WS8 worktree):
- mapping document `08-control-domain-diagnostic-v1-envelope-mapping.md`: `8e63787d7054aba3b4dd54cf2b692ca5b8a986e2667bc89bba0b3e831e2debae`
- example `08-control-domain-diagnostic-v1-envelope-mapping.example.json`: `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`
- validator `08-control-domain-diagnostic-v1-envelope-mapping-test.py`: `fc7cb33eca6f384a47c865bf8ce37a49e6aa277c2fe88385ddd375621ed51bf1`

WS2 reran `python3 -B rust/workstreams/08-control-domain-diagnostic-v1-envelope-mapping-test.py` in WS8 worktree: PASS exact dependency SHA pins, 29/29 unique cause/domain pair projection, direct Common Envelope payload, future unknown cause passthrough, six negative structural cases and MCP V1 closed. The mapping now pins WS2 V1.0.1 assets and keeps `message_type=runalith.control.domain-diagnostic.v1` as major discriminator.

Remaining requested negative guardrails are not yet present: wrong-but-valid domain_code for a known cause; duplicate cause row; missing cause row; unknown future cause with non-null domain_code. WS2 therefore keeps `CHANGES_REQUIRED; MAPPING_DRAFT_NOT_RATIFIED` until WS8 publishes another immutable successor with these cases and exact hashes. WS2 response to latest WS8 report is A2A `47a4f9b1-c032-4d34-9803-2444f78e9ae5`. WS1 mapping review `f73ca4e5-678c-4d59-81e1-f4d0d6114928` is CHANGES_REQUIRED; WS1/WS3/WS7 mapping reviews are not all closed.

WS6 V1.0.1 schema/payload review accepted with blockers; exact hashes and JSON Schema validation pass (A2A `4423a7f8-b3c6-49e2-97f6-8afa0f3613bb`). WS1 V1.0.1 schema/fixture conformance accepted with blockers; WS3 accepts consumer schema/fixture boundary only. WS7 review remains pending. None ratifies runtime route, Common Envelope, HTTP/retry, payload digest canonicalization, authority or production behavior.

**V10.11 overall:** WS2-owned contract/test artifacts and bounded independent reviews are complete; WS8 mapping guardrails and WS7 consumer review remain open; Project Owner/Host Security NOT_ASSIGNED; no contract ratified; no production dispatch/cutover authorization; release readiness NOT_PROVEN.

## 21. Current A2A stopping point

WS2 inbox last read through sequence **893**. All received review/ACK messages through that sequence were acknowledged. No newer WS7 or WS8 response was present at last read. Pending: WS7 V1.0.1 consumer review; WS8 mapping negative-guardrail successor; WS8/WS1/WS3/WS7 final mapping review; Project Owner/Host Security appointment and authority decisions. Do not interpret queue delivery as acceptance.


## 22. WS2-side WS8 mapping mutation oracle

WS2 published a separate reviewer-owned conformance oracle without editing WS8 files:
- fixture `02-control-domain-diagnostic-ws8-mapping-review-v1.fixtures.json` SHA-256 `463e363c6b5688a5fbc137c7cf3cd4aa9e490b90cbce631eb1a09ac59c658807`;
- validator `02-control-domain-diagnostic-ws8-mapping-review-v1-test.py` SHA-256 `5c23d7faaf78c1008d59a9cdc678fe504b4cdf16b2f7f61f54d83f1aa0038dfa`;
- document `02-control-domain-diagnostic-ws8-mapping-review-v1.md` SHA-256 `36a10962879f2b9a1ba8dd4affc86882fd7c280da61d5bafec1fe89c0513a8c1`.

Command `python3 -B rust/workstreams/02-control-domain-diagnostic-ws8-mapping-review-v1-test.py`: PASS. It pins the actual WS2 V1.0.1 schema/fixture and V2.3.1 source fixture; verifies 29/29 known cause-domain pairs; mutates a known cause to a different valid domain and expects mismatch rejection; duplicates a cause row and expects rejection; removes a source cause and expects exact coverage rejection; supplies unknown future cause with non-null domain and expects attribution rejection; preserves unknown future cause with null domain as `UNKNOWN/UNRESOLVED`. This is a WS2 acceptance oracle only, not proof WS8 implementation currently exercises these mutations. WS8's current validator remains at six negatives; WS2 asked WS8 to incorporate equivalent explicit guards into its own immutable successor (A2A request `a908fefc-24d1-494d-940a-0d6fe0dd8272`, follow-up review message `b8284922-339d-41bd-84fc-8799ffd7a88f`).

## 23. WS3 exact revision reconciliation and mapping review status

WS3 reported in seq900 that its prior mapping review request referenced stale V1.0.0 hashes, while current WS8 files were V1.0.1. WS2 independently rehashed the current WS8 candidate and reran its validator:
- mapping doc `8e63787d7054aba3b4dd54cf2b692ca5b8a986e2667bc89bba0b3e831e2debae`;
- example `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`;
- validator `fc7cb33eca6f384a47c865bf8ce37a49e6aa277c2fe88385ddd375621ed51bf1`;
- Common Envelope schema `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2`.

WS2 rerun PASS: exact dependency pins, 29/29 unique exact source pairs, direct payload projection, unknown future cause/null preservation, six current negative cases and MCP V1 closed. WS3 said current candidate mapping principles are acceptable for mapping-only scope but requested a fresh exact-hash review. Its earlier response remains `CHANGES_REQUESTED` for revision mismatch; it is not a final rejection of these current V1.0.1 bytes. WS2 attempted a fresh exact-hash WS3 review request; no durable send receipt was obtained, so exact current WS3 mapping review remains PENDING. WS1's previous mapping review of V1.0.0 is `CHANGES_REQUIRED`; WS7 review also pending. Do not count the old review as acceptance of the current candidate.

## 24. WS3 prepared renewal API source review: producer-side DTO vs HTTP route

WS2 reviewed WS3 final consumer source report `control_http.rs` SHA-256 `e51cacfa16dc5fe21af50d6d91b4913a96fd35a6a77c242909bd665f27d535a3` (WS3-reported current source; WS3 reports control_http 15/15 and full worker 97 library + 3 binary tests PASS). WS2 response to WS3: A2A `9d8e93e7-0f84-4b36-8281-5169d5b53f75` initially; follow-up `53d19267-b310-4cae-8727-33a951f1ec34`.

Producer-side Store DTO evidence (Store source SHA `a08e43b192d02666f8b5956fa8122bd6acaf996524160c4414d5870e49ffe3e3`):
- `TaskLeaseRenewalRequest` lines 800–817 includes `renewal_id`, workflow/task/lease/worker/attempt/owner_epoch/lease_ttl_seconds; no `claim_id`.
- `TaskLeaseRenewal` lines 822–843 serializes exact snake_case fields `renewal_id`, `workflow_id`, `task_id`, `lease_id`, `worker_id`, `attempt`, `owner_epoch`, `previous_expires_at`, `expires_at`, `renewed_at`; no `receipt_id`. These fields match WS3's newly required HTTP success-response names/types.
- `validate_lease_renewal_request` lines 10313–10329 enforces TTL `1..=600`. Control API route at `runalith-control-api/src/lib.rs` lines 512–541 independently enforces `lease_seconds` `1..=600`, validates `renewal_id`, and invokes injected authority.
- Store `renew_task_lease` uses IMMEDIATE transaction; exact same renewal ID and tuple replay original expiry only while same current live RUNNING lease/worker/attempt/epoch; changed tuple conflicts; expired or changed owner replay is `LeaseFenced`. Store-local tests PASS 6/6 (WS2 independently rerun).

Critical HTTP integration boundary:
- `WorkerControlAuthority::renew_lease` at `runalith-control-api/src/lib.rs` lines 95–100 accepts `&Value` and returns `Value`; route only checks the result is an object (lines 625–629). It does not enforce the renewal receipt schema or exact field names/types.
- `ControlApi::from_store` initializes `worker_control=None`; `.with_worker_control_authority(...)` is optional. Standalone `serve_command` at `runalith-control-api/src/main.rs` lines 745–759 does not configure that worker authority. Worker-control routes therefore fail closed with 503 in this standalone composition.
- Search of `rust/crates` found only test `FakeWorkerAuthority` implementation; no concrete Store-backed `WorkerControlAuthority` adapter was found. The fake renewal response is only a partial object and does not prove production DTO conformance.
- Current HTTP request shape is `{renewal_id, claim, lease_seconds}`, not direct `TaskLeaseRenewalRequest`; an adapter must authenticate the claim and explicitly map the fields.

**Disposition:** Store DTO field compatibility `VERIFIED`; TTL bound compatibility `VERIFIED`; actual WorkerControlAuthority HTTP success response `NOT PROVEN`; standalone worker-control backend `NOT WIRED`; `claim_id` in Store renewal subject `ABSENT`; durable `receipt_id` `ABSENT`; WorkerStore journal and supervisor integration `NOT PROVEN`. WS3 must keep response mismatches `UNKNOWN` and must not assume the Store DTO is already returned by HTTP. No end-to-end renewal contract acceptance.

## 25. Authority response and current inbox

WS6 exact response to WS2 authority relay is `ebdba684-ae9e-4ea3-8868-2c45f540fa68`, following WS2 relay `b9bc6acb-893d-43cf-a675-70956e5611ed`. Disposition: `PENDING / NOT_ASSIGNED`, neither approved nor rejected. No Project Owner/authorized architecture owner, appointment artifact/hash, Host Security endpoint, human escalation channel, decision record/hash, or named escalation owner is available. WS6 cannot approve/reject WS4 v6→v7 migration or decide Control attempt semantics. Current owner split remains WS4 provider identity/effect; WS2 Control CAS/workflow truth; WS3 TaskClaim consumer and attempt journal; WS6 trust policy only after named authority assignment. WS2 relayed exact status to WS3 as message `4b4e7a6c-19f8-47ae-8fe0-3bdec1f50afa`.

WS2 inbox last read through sequence **929**. No WS7 response or newer WS8 mapping successor response was present at that read.

**V10.12 overall:** WS2-owned source-pinned contracts, fixtures, validators and local review oracles implemented; independent WS1/WS3/WS6 producer/consumer scope approvals recorded where exact; WS8 mapping mutation coverage remains CHANGES_REQUIRED; WS7 review remains pending; HTTP renewal producer integration remains NOT PROVEN; Project Owner/Host Security authority NOT_ASSIGNED; contracts NOT_RATIFIED; production dispatch/cutover NOT_AUTHORIZED; release readiness NOT_PROVEN.

## 26. WS8 mapping V1.0.1 R3

WS8 supplied a new immutable mapping revision. WS2 independently rehashed and ran its validator in the WS8 worktree: PASS.

- Mapping doc SHA-256: `99cc73c032c0706be4138847ccfe2f064cda9c025a9149023778e8535180a3eb`
- Example SHA-256: `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`
- Validator SHA-256: `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`
- V1.0.0 history index SHA-256: `aca539e0e605f874b16c521a3b51192d99c8f767cacf7a416c7c0a13a2120e8a`

Validator PASS: exact dependency SHA pins; unique 29/29 cause/domain projection; wrong-but-valid domain mutation; duplicate/missing mapped rows; duplicate/missing source rows; unknown future cause with null domain accepted as UNKNOWN/UNRESOLVED; unknown future cause with non-null domain rejected; direct envelope payload; six DTO negatives; MCP Error V1 remains closed.

WS2 disposition: `ACCEPTED_WITH_BLOCKERS_FOR_STRUCTURAL_ENVELOPE_MAPPING; DRAFT_NOT_RATIFIED`. Mapping only. Canonicalization remains test-only; no runtime route, digest profile, auth, HTTP/retry, cryptographic or production proof. WS2 A2A reply `a2afe152-28f8-4cc1-8c99-4db6ce0388e0`.

History limitation: V1.0.0 history JSON preserves prior document/example/validator hashes and A2A review dispositions, and states old bodies could not be recovered. This is a hash/disposition index, not the original artifact bytes. Historical V1.0.0 byte preservation remains `NOT_PROVEN / UNRESOLVED`; do not claim the JSON is an artifact archive. V1.0.1 uses distinct versioned paths and does not overwrite any old bytes, but the original V1.0.0 bodies remain absent from available worktrees/exports.
## 27. WS1 source drift and exact-hash oracle follow-up
WS1 reviewed the WS2 V1 mapping oracle and required a successor that hashes actual WS8 R3 document/example/validator bytes, not only the oracle pair table. WS2 published mapping-review V2 with byte-identical WS8 snapshots. Fixture SHA `9a040442297d8cfbe4d35de75ce6abeddd39381a1f33104dd7081201dfdb65ed`; validator SHA `cccc0d7c81ab024522b3db44eddc9790f8d2410e63bca55b4cbd236900c404b1`; document SHA `e28d384381a83cf9733ec8414f8e2920da10492b7f98c090216a95e744b7ee21`.
V2 recomputes SHA pins for WS8 R3 doc/example/validator, WS2 producer inputs, V2.3.1 source fixture and Common Envelope schema. It PASSes exact unique 29/29 pairs; wrong domain; duplicate/missing map/source rows; unknown future/null; unknown future/non-null rejection; envelope example; six DTO negatives; MCP V1 closed.
One blocker remains in WS8 R3: mapping doc says producer DTO `1.0.0-draft`, but referenced WS2 DTO is `1.0.1-draft`. WS1 requires immutable WS8 V1.0.2/errata correction before final exact content acceptance; R3 snapshot remains unchanged.
WS1 source drift note is `02-control-domain-error-diagnostics-v2.3.1-source-drift-note.md` SHA `7d8ac8a9a2be38417e2b3ca28c56eb7af75e08278dee9185e540e0dc6835a02a`. The frozen V2.3.1 29-code inventory is unchanged; helper errors remain unmapped absent caller integration.
WS2 inbox last read through sequence 971. WS3 confirms Store DTO shape/TTL compatibility only; HTTP producer remains NOT WIRED. WS6 authority remains PENDING/NOT_ASSIGNED. WS1/WS3/WS7 R3 mapping review and WS8 errata remain open. Contracts NOT_RATIFIED; production dispatch NOT_AUTHORIZED; release readiness NOT_PROVEN.
Separate source-drift clarification note: `02-control-domain-error-diagnostics-v2.3.1-source-drift-note.md`, SHA-256 `7d8ac8a9a2be38417e2b3ca28c56eb7af75e08278dee9185e540e0dc6835a02a`. V2.3.1 remains frozen; new helper error type is outside 29-code inventory.
WS2 inbox last read through sequence 971. WS3 accepts Store DTO shape/TTL only; HTTP producer remains NOT WIRED. WS6 authority remains PENDING/NOT_ASSIGNED.
WS1/WS3/WS7 review of exact R3 mapping remains pending. WS8 erratum request `8c3d5ee6-a679-43ef-b46c-c2327ddc8ce1`; WS1 oracle review request `caeda90b-5f16-43f3-8fa3-b7dafb26bbcc`. Contracts NOT_RATIFIED; production dispatch NOT_AUTHORIZED; release readiness NOT_PROVEN.
## 28. WS8 R5.4.2 canonical export review V3
WS8 R5.4.2 export mapping doc hash e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653. Example hash eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3. Validator hash dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130. DTO label is now 1.0.1-draft.
V3 oracle fixture `4ba40924a5952c666f4c9fcc561979a517fbc631186d82081591f028a5337195`, validator `ebe7812df65639e6b6c4e1044834f72b7b1ca39790b9a285399a4c4f1be1cdb9`, document `d928717b725b72ee94942ba4d96f5b8bd5fcbb35e4488b638f6e2bd9782cdddb`. Command `python3 -B rust/workstreams/02-control-domain-diagnostic-ws8-mapping-review-v3-test.py`: PASS exact source/doc/example/validator pins; exact 29/29; four mutation classes plus duplicate/missing source; unknown future null/non-null; six DTO negatives; envelope example.
The corrected doc is from canonical WS8 R5.4.2 export. WS8 isolated live worktree still returns prior mapping doc SHA `99cc73c032c0706be4138847ccfe2f064cda9c025a9149023778e8535180a3eb`; canonical export SHA is `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`. WS2 requested live/export reconciliation as A2A `bc1ea6ea-8682-4aed-9ee8-da671ce6003a`. V3 accepts the frozen export snapshot only, not live worktree identity.
## 29. A2A update after V3 export review
WS8 seq994 confirmed corrected V1.0.1 doc SHA `e8c60aaf856d8280a2aeb4b240d3049d73f26a7ab466d57af3f5f808ae6a5653`, unchanged example `eaeeae93dd4ba4a195a4bacf5bfb2f682c9ae7c61f7ce00b76b9579e3edd0eb3`, validator `dbd8f166f151d171a06e3ba5a9e91ec63519b0c207231d18805a807e0b324130`. WS2 accepted structural mapping with blockers by reply `61ed96d3-1c03-43c6-b1c7-33aa39ebfe47`.
Live/export reconciliation pending: WS8 live worktree hash 99cc73c..., canonical R5.4.2 export hash e8c60aaf.... WS2 request `bc1ea6ea-8682-4aed-9ee8-da671ce6003a`; V3 acceptance applies to export snapshot only.
WS1 ACKed WS2 oracle V2 and supplied final source-drift confirmation; WS2 replied to WS1 with V3 path, command and mutation inventory as A2A `af9d9445-8f0a-4c17-bf7b-421b24ea33f1`. WS2 inbox last read through sequence 1019. WS7 consumer review and WS8 live/export reconciliation remain pending; Project Owner/Host Security remain NOT_ASSIGNED.
WS1 independently validated V3 and accepted it with structural mapping blockers, DRAFT_NOT_RATIFIED, for canonical R5.4.2 export snapshot only (A2A `ea3a3d7d-b941-4c56-9b24-d77ea566af4f`). WS8 confirms the frozen source snapshot/current helper boundary (A2A `65709476-6b8e-4b8b-9452-032910152f03`). Latest WS2 inbox read through sequence 1040.
