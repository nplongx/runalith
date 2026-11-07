# WS2 producer DTO boundary v1 — DRAFT

**Status:** DRAFT / NOT RATIFIED. No source, schema, Store, service, route or migration change is authorized.  
**Logical vectors:** `02-control-worker-boundary-v1.fixtures.json` SHA-256 `3f00ee830c292ac1d0baf984a49e30d665ecdde1c0610ae966c955d6cb2e41bd`.  
**Validator:** `02-control-worker-boundary-v1-test.py` SHA-256 `4b5a6de12704909ad6ee97ef16b74faee6280324ed35819558a6b80ab5235d63`.

This is WS2's producer-side field proposal responding to WS3's request for exact DTO names and logical vectors. It is not a signed-byte golden corpus; signature algorithm, issuer/key domain and canonical signer bytes remain authority/consumer gated.

## 1. TaskClaimV1 / TaskClaimEnvelopeV4

Logical producer DTO keeps the cross-part name `TaskClaimV1`; its inner worker payload version is `schema_version: 4`. The V4 payload contains `claim_id`, `issuer`, `audience`, `issued_at`, `expires_at`, `idempotency_key`, `workflow_id`, `task_id`, positive `attempt`, positive `owner_epoch`, `lease_id`, `worker_id`, `plan_sha256`, `command_sha256`, explicit top-level `acl_sha256`, exact typed `command`, optional exact `provider_dispatch`, `session_messages`, and an authenticator envelope.

`acl_sha256` is a lowercase 64-character SHA-256 digest and is part of the complete signed claim subject. The authenticator itself is not recursively included in its own signature preimage; its signature binds the complete claim subject bytes. The exact serialization/preimage rule must be agreed with WS3 and signed-byte vectors produced before implementation. V3 remains unchanged and must never be widened implicitly to V4.

The fixture authenticator is explicitly `fixture_only`; it is not a signature and grants no authority.

## 2. ExecutionFenceV2

The existing Control Store request type is `WorkerExecutionFenceRequest` with fields:

`claim_id`, `workflow_id`, `task_id`, `attempt`, `lease_id`, `worker_id`, `owner_epoch`, `plan_sha256`, `side_effect_id`, `kind`, `request_sha256`, `idempotency_key`, `acl_sha256`.

The existing completion type `WorkerExecutionFenceCompletion` carries the same immutable subject plus `fence_id`, `outcome`, `event_id`, `event_sha256`, and `outcome_sha256`. Thus Store already has first-class `attempt` in both request and completion DTOs. WS3's ExecutionFenceV2 consumer must preserve the identical subject through reservation request, reservation response, completion request and durable completion receipt. A completion may not rebind another attempt.

### Proposed receipt shape

Reservation receipt adds explicit `receipt_id`, `fence_id`, the complete reservation subject, `state=RESERVED`, `durable=true`, and `persisted_at`.

Completion receipt adds explicit `receipt_id`, the complete immutable completion subject (`fence_id`, claim/workflow/task/attempt/lease/worker/epoch/plan/side-effect/kind/request digest), exact `outcome`, event identity/digest, `outcome_sha256`, `completion_sha256`, `durable`, `terminal`, and `persisted_at`.

The current Store `WorkerExecutionFenceRecord` contains `receipt: Value`, `created_at` and optional `completed_at`; `WorkerExecutionFenceCompletionResult` contains the typed completion, `completion_sha256`, receipt, `recorded_at` and `terminal`. Current reservation receipt JSON contains fence ID/request digest/durable/recorded time. Current completion receipt JSON contains fence ID/event ID/event digest/outcome/completion digest/durable/recorded time/terminal. It does not expose a typed `receipt_id` or repeat all subject fields inside the receipt object. The full subject is available in the surrounding typed record/event payload, but the compact receipt itself does not currently meet the proposed full-binding receipt shape.

`UNKNOWN` and unverified `NOT_STARTED` remain observations, `terminal=false`, and do not release the reservation. `SUCCEEDED`, `FAILED`, or proof-verified `NOT_STARTED` require the independently provisioned completion verifier inside the same Store transaction before terminal release. A digest alone is not proof.

## 3. LeaseRenewalV1

Proposed request fields:

`schema_version`, `renewal_id`, `claim_id`, `workflow_id`, `task_id`, `attempt`, `lease_id`, `worker_id`, `owner_epoch`, `lease_ttl_seconds`.

Proposed durable receipt fields:

`schema_version`, `receipt_id`, `renewal_id`, `claim_id`, `workflow_id`, `task_id`, `attempt`, `lease_id`, `worker_id`, `owner_epoch`, `lease_ttl_seconds`, `previous_expires_at`, `expires_at`, `persisted_at`, `durable`.

The current Store `TaskLeaseRenewalRequest` already has `renewal_id`, workflow/task, lease, worker, attempt, owner epoch and `lease_ttl_seconds`; it lacks `claim_id`. Current `TaskLeaseRenewal` returns the same subject except claim ID/receipt ID, plus previous/new expiry and `renewed_at` (equivalent persistence-time evidence, but different field name). The Store transaction persists a renewal row and lifecycle event; exact same ID/body returns original expiry while the same owner is current, changed body under the same ID conflicts, and stale owner is rejected. The Store struct is implementation evidence, not the full cross-part DTO.

The existing Worker Control API v1 transport is `{renewal_id, claim, lease_seconds}` and documents same-ID/same-request retry. The current Rust worker HTTP method generates a new UUID inside each `renew_lease` invocation and has no same-invocation retry path. Exact retry remains NOT PROVEN at the worker transport layer. A new heartbeat must use a new renewal ID; one logical heartbeat retry must reuse the original durable ID and exact request bytes.

## 4. Vector/test evidence and limits

`python3 rust/workstreams/02-control-worker-boundary-v1-test.py` passes 3 positive contract groups and 18 negative mutations. It checks explicit ACL binding, exact claim/fence/renewal subject continuity, full receipt fields, UNKNOWN non-terminal semantics, stable renewal identity and expiry replay.

This is logical fixture validation only. It does not call `runalith-store`, `runalith-control-api`, or the worker client; it does not verify signatures, transaction isolation, crash/restart integration, actual receipt bytes or production authority. Existing Store test suite remains the separate runtime evidence (99 tests in the earlier WS2 rerun), not proof that these proposed DTO shapes are implemented.

## 5. Owner split and next review

- WS2 owns Control producer-side claim authority/DTO, lease renewal producer/receipt, fence reservation/completion producer/receipt and authoritative completion CAS.
- WS3 owns worker V4 claim parser/verifier consumer, ExecutionFenceV2 client DTOs, worker renewal retry journal and WorkerStore V1 compatibility/migration.
- WS6/Project Owner must approve any trust domain, issuer, signer, verifier and freshness/revocation policy. No GovernanceApprovalReceipt reuse is inferred.
- W4 owns ProviderTerminalProof and provider account/run truth. W3 local ProcessStop remains unsigned/local-only until a separate approved attestation policy exists.

Required review before source implementation: WS3 confirms the field crosswalk and canonical producer/consumer bytes; WS2 owner is assigned; receipt ID/persisted timestamp behavior and stable renewal retry are ratified; Project Owner approves any required persistence/authority boundary. No source, WorkerStore, Control Store schema, route, production signer, settlement or migration change is included in this work.
