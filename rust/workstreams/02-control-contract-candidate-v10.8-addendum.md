# WS2 Control Contract Candidate V10.8 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base lineage:** V10.7 (`f5ea0c4403f3abc052165a9cb408284fb2b1d0bcce061ce62ac2545404d620f7`)  
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
