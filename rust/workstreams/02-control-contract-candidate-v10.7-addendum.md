# WS2 Control Contract Candidate V10.7 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base lineage:** V10.6 (`258a8971039183afa733842a5ea6e287ed65f3647510bac1bfab142c75b3788e`)  
**Purpose:** consolidate WS2-owned contract clarifications and cross-workstream evidence without implying production readiness.

## 1. Control/Worker logical consumer convergence

WS3's immutable V2.1 producer snapshot is the current logical consumer candidate. WS3 reports 13/13 Rust draft-consumer tests, 3/3 Node differential tests and 168/168 full Rust target tests. Final WS3 disposition: `ACCEPTED_WITH_BLOCKERS_FOR_LOGICAL_CONSUMER_MAPPING; DRAFT_NOT_RATIFIED` (A2A message `6c1deb3b-1be4-4b48-971a-065a0c3a62b7`). This is agent-reported final evidence; WS2's earlier independent run covered 11 tests, not the final expanded 13. No production WorkerStore, HTTP or Control route behavior is established. V1 and V2 snapshots remain immutable historical artifacts.

## 2. CommandRequest V1.2

V1.2 corrects V1.1 consumer provenance. WS3's authoritative consumer vector file contains two vectors (`ef588350b9571bb0d25bdade003eecefe64329e66d57ad79c673d02dc64a1b35`); the WS2 176-byte printf vector is a separate supplement (`9baf0b0cbee999ef8041bea5285021702a192cdd3e1fc718a355af973d26819e`); producer fixture snapshot is separate (`2995ea0be2b1d4465e2306021b4a4fd730be5c0d5f258d297855b8a2d0a7958f`). V1.2 fixture SHA `9fdf25e450abb5c585bcc1dc213cb620d59bcd87e884c69501ffc3b5e3a48996`; validator SHA `e203b940cc2f6b105a51d30b0ee48eec09e557c38f390e10c7e74710b5357787`; document SHA `7cd1bbdeae5ad9a2ed7024687d0de2d002e689e4e5e49f348d3ee0fa598e2587`. Local validator passes three exact vectors and six negative mutations. This pins current `CommandRequest` serialization only; it does not establish TaskClaim V4 signed bytes/authority, W1 task mapping, or command execution. V1.1's stale source pin is not carried forward.

## 3. Diagnostics V2.3

V2.3 fixture SHA `fb48d1cfceb53baa54765eff7a2de716130b9953f504189992973d654ff98750`; validator SHA `df3f18b2a81be18e35272e355cfa3bea14417ccd4870ab3ce017490da2e72008`; document SHA `7c6a1c57b729c3239299eabeb40fb732ca8b38fcf6cdcf7eaf28295e8de2499e`. Validator passes exact 29-code inventory, origin/propagation/test separation, ApprovalDecision 21+2+1 partition, ApprovalPolicy nine-code inventory, phase attribution, conservative `REVIEW_REQUIRED` partition and WS6 source-hash pins. It is static fixture/source-hash validation, not dynamic Rust source scanning or runtime completeness proof.

V2.3 preserves `domain_code` and exact `cause_code` separately. `AGG_APPROVAL_SIGNATURE_INVALID` is caller authentication failure only in `verify_input_signed_envelope_signature` phase. Ambiguous envelope, host signer-output, host clock, signed timestamp, host key/config, trust-root, snapshot, signature binding and digest/integrity cases remain `REVIEW_REQUIRED` where attribution is not proven. Scope is bounded; not a complete `runalith-trust` inventory. Independent WS1/WS6 review remains pending.

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
