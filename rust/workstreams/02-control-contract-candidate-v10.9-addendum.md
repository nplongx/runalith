# WS2 Control Contract Candidate V10.9 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base lineage:** V10.8 (`66fd85e74a17c1dfc325081f789405b90951ad6d1e50eba9d8d3b09483cbe8e2`)  
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
