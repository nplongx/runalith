# WS2 Control Contract Candidate V10.29 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.28 SHA-256 `3bd109078345047e09335b3b88e209745983337cd4cbb365ce40804fc0c1445f`  
**Purpose:** answer WS3's formal CR-03 producer request A2A seq1363 with exact Store DTO, transaction/CAS, idempotency/replay limits, and explicit NOT IMPLEMENTED HTTP/authority boundary.

## 1. WS3 request and direct producer disposition

WS3 request message: `352cebd2-bdbc-4f1e-a07a-d0bfa9cc72f9`, correlation `COS-A2A-WS3-WS2-RENEWAL-INTEGRATION-20261104-01`. WS2 acknowledged it and sent a bounded response via new A2A message `d2f1aeeb-70ee-4b5e-9f1d-ce713ad58369` (queued at last read).

**Disposition:** `CHANGES_REQUESTED / BLOCKED`. Existing Store idempotency/CAS is implemented and tested; no ratified producer HTTP DTO, Store-backed `WorkerControlAuthority`, authenticated receipt issuer or golden HTTP receipt bytes exist.

## 2. Exact current internal Store DTOs

Source: `rust/crates/runalith-store/src/lib.rs` SHA-256 `a08e43b192d02666f8b5956fa8122bd6acaf996524160c4414d5870e49ffe3e3`.

`TaskLeaseRenewalRequest` (source lines 797–817):

`renewal_id, workflow_id, task_id, lease_id, worker_id, attempt, owner_epoch, lease_ttl_seconds`.

`TaskLeaseRenewal` (source lines 819–843):

`renewal_id, workflow_id, task_id, lease_id, worker_id, attempt, owner_epoch, previous_expires_at, expires_at, renewed_at`.

The append-only SQLite table `task_lease_renewals` (source lines 7910–7942) has `renewal_id TEXT PRIMARY KEY`, a unique durable ledger row per renewal ID, foreign key to exact `task_attempts(workflow_id,task_id,attempt)`, and no-update/no-delete triggers. This is an internal persistence DTO/table, not a public HTTP contract.

Not present in these DTOs/row: `claim_id`, `receipt_id`, request-body digest, `schema_version`, `issuer`, `audience`, signature/authenticator, signed receipt or explicit expected-previous-expiry request field.

## 3. Exact Store transaction and CAS behavior

`Store::renew_task_lease` source lines 4864–5050:

1. Validate Store request, lock connection, open `TransactionBehavior::Immediate`, fail closed if Store quarantined.
2. Look up `renewal_id` in `task_lease_renewals` before mutation.
3. If row exists, compare workflow/task/attempt/owner_epoch/lease_id/worker_id/lease_ttl_seconds. Any change returns `LeaseRenewalConflict`.
4. For exact duplicate, recheck the task remains `RUNNING` with exact attempt/owner epoch/lease/worker and `lease_expires_at > now`. If current ownership no longer holds, return `LeaseFenced`. Otherwise commit the read transaction and return the originally stored receipt without extending expiry again.
5. For a new renewal, read current task state/attempt/epoch/lease/worker/previous expiry. Reject missing task, non-RUNNING, stale attempt/epoch, lease or worker mismatch, missing/expired lease.
6. Compute a strictly later expiry. Conditional UPDATE includes exact workflow/task, `state='RUNNING'`, attempt, owner epoch, lease ID, worker, exact previously observed `lease_expires_at`, and `lease_expires_at > renewed_at`. Require exactly one changed row.
7. Insert the renewal ledger row and append `task.lease_renewed` event with event idempotency key `lease.renewal:{renewal_id}` in the same transaction; commit; return ten-field `TaskLeaseRenewal`.

The caller does not send expected previous expiry; Store reads it and CASes that exact observed value. Renewal row does not bind `claim_id` or an explicit request digest. Receipt is a durable Store projection, not cryptographically authenticated.

## 4. Test evidence run by WS2

All commands below ran from `rust/` against current source; each targeted test PASS 1/1:

- `cargo test -p runalith-store --locked --offline lease_renewal_is_atomic_idempotent_and_bound_to_exact_owner_epoch`
- `cargo test -p runalith-store --locked --offline exact_lease_renewal_receipt_replays_after_store_restart_without_extending_again`
- `cargo test -p runalith-store --locked --offline lease_renewal_replay_after_expiry_and_quarantine_is_fenced`
- `cargo test -p runalith-store --locked --offline concurrent_identical_lease_renewal_replay_is_single_commit_across_store_connections`
- `cargo test -p runalith-store --locked --offline concurrent_conflicting_lease_renewal_payloads_have_one_idempotency_winner`
- `cargo test -p runalith-store --locked --offline expired_lease_renewal_races_with_quarantine_and_never_resurrects_owner`

These prove same-request replay after Store restart while same lease is current/live, single commit under concurrent identical requests, conflict for same ID with changed TTL, and fencing under expiry/quarantine. They do **not** prove unconditional historical receipt replay after expiry, terminalization, quarantine or reassignment; this is intentionally fenced.

Control API source hashes:

- `rust/crates/runalith-control-api/src/lib.rs`: `9044441a6fab7e15a7953d39ba2b36acacca9af7a98b7929f51cf867477bb0ce`
- `rust/crates/runalith-control-api/src/main.rs`: `aea660103453d9f533cac1c71c8a2bead311dc894064de2bc15d760a7f4e31a4`

`WorkerControlAuthority` remains `Value -> Value`. `/v1/worker/leases/renew` validates nested `claim.worker_id` and `claim.audience` against authenticated principal, TTL and renewal ID, then delegates the raw body. `ControlApi::from_store` sets `worker_control=None`; standalone host does not inject an authority, so worker routes fail closed with 503. No concrete Store-backed adapter exists. Targeted tests `worker_routes_fail_closed_when_authoritative_backend_is_not_configured` 1/1 and `worker_claim_routes_bind_authenticated_subject_and_capabilities` 1/1 PASS use a fake test authority only.

## 5. Request/response version mismatch — not silently resolved

Current WS3 `HttpControlPlane` sends `{renewal_id, claim, lease_seconds}` and parses a closed ten-field response matching `TaskLeaseRenewal` field identity/time fields. It does not prove the actual HTTP route reaches Store.

A separate WS2 `LeaseRenewalV1RequestDraft/ReceiptDraft` proposal adds `schema_version`, `claim_id`, `receipt_id`, `lease_ttl_seconds`, `persisted_at`, and `durable`. That proposal is a different shape. WS3 has not received approval to collapse it; no public request/response version or canonical byte profile is ratified.

A next version must explicitly choose whether `claim_id` and `receipt_id` are first-class fields, bind issuer/audience and exact request digest, define same-ID replay/error outcomes, and document the mapping from `{renewal_id,claim,lease_seconds}` to the flattened Store request. It must preserve expiry/owner fencing and distinguish committed receipt from ambiguous transport outcome. Publish cross-language canonical request/response vectors only after profile approval.

## 6. Authority ownership

WS6 A2A seq1301 / message `22e2251d-f76f-424e-98ce-6a3f686e2d2d` confirms TaskClaim issuer/claim issuance is WS2/Control-owned; WS3 owns worker consumer and audience binding; WS6 owns trust-root/key lifecycle only after Project Owner/authorized architecture owner + Host Security appoint the authority and ratify a trust profile. No signer, key custodian, issuer identity, audience registry, signing preimage/profile or production verifier is currently assigned/provisioned. Renewal receipt issuer is likewise not implemented.

No production adapter, mock endpoint, signed receipt or golden authenticated HTTP bytes are published. Existing source DTOs and Store tests are current internal evidence, not an approved producer contract. Project Owner must assign WS2 implementation owner and approve exact source/module/worktree authority before implementation. Host Security must appoint signer/key authority. No source/schema/SQL/API/deployment change was made by WS2.

**CR-03 overall:** local Store CAS/idempotency and WS3 client journal are evidenced; WS3 consumer retry subpart is `ACCEPTED_WITH_BLOCKERS`; Control HTTP producer/Store adapter, claim/receipt authority, exact cross-part DTO and signoff remain `OPEN / BLOCKING / DRAFT_NOT_RATIFIED`.
