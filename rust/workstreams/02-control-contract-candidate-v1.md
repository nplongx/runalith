# WS2 Control contract candidate v1

**Status:** DRAFT — producer candidate for review; NOT RATIFIED and not a deployment contract.
**Owner:** WS2 contract authoring only; accountable individual remains UNASSIGNED.
**Architecture:** Workflow Control is one of exactly three deployables under ADR 0003. WS2 is a domain inside that deployable, not a separate service.
**Authority:** `rust/EIGHT_PART_PARALLEL_PLAN.md`, `rust/workstreams/02-workflow-control-lifecycle.md`, accepted ADR 0003.
**Source snapshot:** working tree based on `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`; Rust tree and workstream artifacts are untracked in this checkout. This candidate does not claim a clean-checkout or committed revision.

This document makes WS2's existing lifecycle invariants reviewable as a bounded contract candidate. It does not freeze a shared schema, replace the existing Worker Control API v1, ratify W8's common envelope, assign a production authority, or authorize source/schema/database/deployment changes.

## 1. Ownership and contract boundary

WS2 owns authoritative workflow, task, attempt, lease, coordinator/fairness, Control journal, result-inbox, workflow-local policy/success evaluation, cancellation-request and recovery-orchestration semantics.

WS2 does not own:

- catalog definitions, role definitions, typed task compilation or immutable plan compilation (WS1);
- trust roots, reviewer/nonce state, signer/key custody or approval decision truth (WS6);
- worker/process/sandbox facts or process-stop proof (WS3);
- provider dispatch/run truth or provider terminal proof (WS4);
- session ACL/delivery state, artifact bytes or artifact lineage custody (WS5);
- AGG graph/evidence/checkpoint truth (WS7);
- northbound MCP presentation, wire envelope serialization or gateway routes (WS8).

WS2 changes workflow state only in its own authoritative transaction. External observations and receipts are evidence; they do not mutate Control state merely by being received. No API caller, worker, provider, session store, Gateway or Governance component may write Control-owned lifecycle state directly.

## 2. Common message and persistence semantics

The following are proposed requirements for every cross-part W2 message. Exact envelope field names and serialization remain subject to W8 review.

1. Carry an explicit schema identity/version, immutable message or event ID, authenticated producer identity, intended audience, canonical UTC creation time, correlation ID, idempotency key, exact subject and payload digest.
2. Bind the subject to the relevant `workflow_id`, `task_id`, immutable `plan_sha256`, `attempt`, `lease_id`, `owner_epoch`, and producer/worker identity. Fields irrelevant to a particular message may be omitted only where the contract explicitly says so; omission must never widen authority.
3. Keep transport message ID, command/request ID, event ID, idempotency key, receipt ID and causation ID distinct. A transport ACK is not a domain receipt.
4. An exact retry reuses the same idempotency identity and exact request bytes/digest. It returns the original durable receipt/outcome and must not repeat a state transition or extend a lease again. A reused identity with changed subject or content is a conflict.
5. Persist the inbox identity and corresponding Control event/projection result atomically before returning an acceptance receipt. A stale or rejected event may receive a durable rejection receipt; a receipt must not claim acceptance.
6. Use a monotonic sequence and predecessor digest only for a source-owned ordered journal. A timestamp is not an ordering fence. Consumers reject sequence/predecessor gaps or conflicts as unresolved rather than sorting by timestamp.
7. A missing, invalid, stale, unavailable or ambiguous authority/evidence result stays `UNKNOWN` or `UNRESOLVED`. It is never coerced to false, zero, absent, terminal or success.
8. No contract implies a distributed transaction across deployables or shared database access. Use authenticated public APIs and durable inbox/outbox/reconciliation where a cross-part transition is eventually required.

Digest profiles are deliberately not unified here. The existing Worker API's `event_sha256`, immutable plan digest, command digest, ACL digest, provider payload digest, artifact-byte digest, manifest digest and W8 envelope-payload digest are separate domains. W8 and the owning producer must publish canonicalization bytes and golden vectors before any equality or conversion between these values is permitted.

## 3. Contract candidates

### 3.1 `WorkflowCommandV1` — client/Gateway to Control

**Producer semantics owner:** WS2. **Transport mapping reviewer:** WS8. **Status:** DRAFT; wire shape not frozen.

Required logical content:

- authenticated principal and explicit command/action;
- exact workflow subject (or explicit creation identity for a new workflow);
- immutable request/command identity and idempotency key;
- canonical payload digest and correlation/causation references;
- versioned typed payload for the command being requested.

Control authenticates and authorizes before mutation. An exact command replay returns its original outcome. Reusing a key for a changed actor, action, subject or payload conflicts. Proposal creation or plan compilation alone never approves, admits or claims work. No free-form metadata may be interpreted as an executable command or a timeout override.

The final JSON field names, command enum, digest profile, route, authorization principal mapping and stable error codes require W8 review and a named authority owner. These are intentionally not invented in this candidate.

### 3.2 `WorkflowViewV1` — Control to clients/Gateway

**Producer semantics owner:** WS2. **Transport mapping reviewer:** WS8. **Status:** DRAFT; read-model schema not frozen.

The view is a read-only Control projection. It may expose lifecycle/task state, attempts, current lease/fence references, immutable plan identity, policy attachment identity, event sequence/head and unresolved cancellation/recovery status. It must not manufacture Execution, Provider, Session, Artifact or Governance facts from missing observations. A consumer must be able to distinguish a known terminal state from `UNKNOWN`/`UNRESOLVED` and an incomplete history.

The exact projection shape and whether list/detail views share one DTO require fixtures and W8 compatibility review.

### 3.3 `TaskClaimV1` — Control to WS3

**Producer:** WS2. **Consumer:** WS3. **Status:** DRAFT. Existing Worker API claim schema v3 is related implementation evidence, not a ratified cross-part replacement.

The candidate claim subject binds:

| Field | Requirement |
|---|---|
| `schema_version` | Explicit claim payload schema identity/version; unknown versions reject. Keep this inner version distinct from the cross-part contract label `TaskClaimV1`. Current W3 `TaskClaimEnvelope` source declares version `3`. |
| `claim_id` | Immutable Control-issued claim identity. |
| `issuer` | Authenticated Control service identity; a JSON claim string alone is not host authentication. |
| `audience` | Exact intended worker identity; must be checked against authenticated worker identity, not trusted from caller input. |
| `issued_at`, `expires_at` | Canonical RFC 3339 UTC validity interval; both signed/authenticated with the complete claim. |
| `idempotency_key` | Stable claim issuance identity; exact replay cannot issue another attempt. |
| `workflow_id`, `task_id` | Exact workflow and task. |
| `plan_sha256` | Immutable approved plan digest. |
| `command_sha256` | Digest of exact serialized `CommandRequest` bytes under a named producer-approved canonicalization profile. Distinct from plan, envelope payload, event, ACL, provider and artifact digests. |
| `attempt` | Positive monotonic attempt number. |
| `lease_id` | Unique current lease identity. |
| `owner_epoch` | Positive monotonic fencing epoch. |
| `worker_id` | Exact intended worker identity and audience. |
| `acl_sha256` | Required digest of exact authorization decision inputs used for claim/fence issuance; does not replace transaction-time ACL revalidation. It must be an explicit authenticated field or an explicitly versioned nested signed field, not omitted silently. |
| `authenticator` | Control-issued authenticator covering the complete canonical claim, including issuer/audience/times, every binding, `acl_sha256`, exact command and all nested producer-owned W4 provider-dispatch/W5 session-message bytes/fields. |

Optional provider-dispatch and session-message data remain W4/W5-owned semantics. WS2 may bind their complete immutable representation and digest but must not redefine their private fields or truth.

Source reconciliation required: W3 currently declares `TASK_CLAIM_SCHEMA_VERSION=3` and its `TaskClaimEnvelope` source has explicit `issuer`, `audience`, `issued_at`, `expires_at`, `worker_id`, command, provider dispatch and session messages. The reviewed Rust struct does not expose a top-level `acl_sha256` field, despite the W3 consumer requirement that the ACL decision digest be bound. W3/WS2 must decide whether it is a required explicit field or a versioned nested authenticator subject and publish one exact serialization. Do not infer that a claim v3 authenticator covers a field not present in its DTO. This candidate does not equate the worker payload schema v3 with the cross-part semantic label `TaskClaimV1`; producer/consumer owners must agree on the mapping and publish golden claim bytes before ratification.

### 3.4 `LeaseRenewalV1` — WS3 to Control, receipt back to WS3

**Producer semantics owner:** WS2. **Consumer/transport adapter:** WS3. **Status:** DRAFT; production authority absent.

The request is bound to `renewal_id`, `claim_id`, workflow/task, claim/lease, worker, attempt, owner epoch and requested lease duration. The caller durably creates one immutable `renewal_id` per logical heartbeat before first send and reuses that exact ID and exact request bytes on retry. A new heartbeat uses a new ID. Control atomically verifies the exact current, unexpired lease and owner epoch before applying or replaying a renewal.

An accepted receipt binds a durable `receipt_id`, same renewal ID and claim ID, workflow/task, lease, worker, attempt and owner epoch, previous expiry, new expiry and persisted renewal time. Exact replay returns the original receipt and original expiry without extending the lease again. Changed payload under the same renewal ID conflicts. Expired/stale lease, changed worker, attempt, lease or epoch is rejected; renewal never resurrects an expired or superseded owner.

The existing worker HTTP request is `{renewal_id, claim, lease_seconds}`. The current Store request is `TaskLeaseRenewalRequest { renewal_id, workflow_id, task_id, lease_id, worker_id, attempt, owner_epoch, lease_ttl_seconds }`. WS3 clarified that the current heartbeat loop calls `renew_lease` once per heartbeat interval and fails closed on an error; it does not retry the same heartbeat automatically. A fresh UUID on each independent method invocation therefore describes distinct heartbeat requests and is not evidence that a single heartbeat retry changes identity. The actual gap is that `ControlPlane::renew_lease` has no caller-supplied logical renewal ID or same-request retry path, and its `LeaseRenewal` response exposes only lease ID, owner epoch, worker ID and new expiry, not renewal ID, claim ID, previous expiry, persisted time or durable receipt identity. This leaves future exact-retry behavior and full receipt validation NOT PROVEN, while current ambiguous outcomes remain fail-closed. If a retry path is introduced, persist one ID/body per heartbeat before first send; retries reuse it exactly, next heartbeat gets a new ID. This transport-to-domain mapping is implementation evidence only; contract remains DRAFT.

### 3.5 `TaskResultEnvelopeV1` — WS3/WS4 to Control

**Producer semantics owner:** WS2 for Control inbox acceptance. **Evidence owners:** WS3/WS4. **Status:** DRAFT; producer DTOs and canonical digest profiles require review.

Every result envelope binds immutable event ID, idempotency identity, authenticated producer, workflow/task/plan/attempt/lease/owner-epoch subject, event digest and exact result/evidence references. Provider result details and provider terminality remain W4-owned. Process observations and local process-stop proof remain W3-owned.

Control validates the current fence and producer identity before applying an event. The first accepted event gets a durable Control inbox receipt. An exact duplicate returns its original durable receipt and never reapplies the transition. Same event/idempotency identity with a changed digest conflicts. A stale-owner event may receive a durable `STALE_OWNER` rejection receipt but must not mutate the current projection. A Control inbox acceptance receipt proves only durable receipt of the submitted event; it does not prove that an external evidence manifest, process observation, artifact, provider result or attestation was independently verified. Delayed/out-of-order events are checked against the exact attempt/lease/epoch and producer-owned ordering; timestamp order is insufficient.

W3 owns `ProcessObservationV1` and `ProcessStopReceiptV1`; W4 owns provider terminal proof. Current W3 source makes `ProcessStopReceiptV1` an unsigned `local_worker_process_tree` observation based on exact process/cgroup-v2 populated-zero evidence. It is not a signed cross-service authority receipt, cannot prove a remote provider stopped, and cannot alone release a lease or settle cancellation. W3 producer authentication, an independently approved verifier and exact lineage/fence binding must be ratified before Control can use it as one input to settlement.

The existing Worker Control API v1 describes `event_sha256` as the Runalith typed-JSON `content_hash` over the submitted event payload. The current W3 HTTP adapter first converts the typed event to `serde_json::Value`, then `content_hash` serializes that value with `serde_json::to_vec` and hashes the bytes. This exact implementation profile is distinct from the W8 common-envelope `payload_digest`; cross-language golden bytes still need producer-owned fixtures. It is not authority evidence that a production host is configured: the current standalone host does not inject `WorkerControlAuthority` and `/v1/worker/*` returns `503`.

### 3.6 `CancellationRequestV1` — client/Gateway to Control

**Producer semantics owner:** WS2. **Execution receipt owner:** WS3; provider terminal proof owner: WS4. **Status:** request projection IMPLEMENTED in compatibility Store; cross-part settlement BLOCKED.

The request binds authenticated actor, exact workflow subject, reason and one idempotency identity. An exact actor/reason replay returns the original request projection; changed content under the same identity conflicts and authorization must still be checked before replay. The persisted read projection includes actor, reason, request timestamp and `settlement_status`.

State semantics:

- Before any task attempt exists, an authorized cancellation may terminalize the workflow with settlement `NOT_REQUIRED`.
- Once an attempt/lease exists, Control persists cancellation intent, retains `EXECUTING`, current lease IDs and owner epochs, blocks new direct/coordinator claims and reports `UNRESOLVED`.
- A late exact result under the current fence may be recorded but does not itself settle cancellation.
- Request, HTTP ACK, timeout, local worker exit or lease expiry is not a process-stop/no-more-side-effects receipt and never releases a lease.
- Terminal settlement is forbidden until W3's independently verifiable process-stop evidence and W4's provider terminal proof (where applicable) are accepted and Control can apply the exact settlement CAS/replay rules atomically.

The exact cross-part receipt, signer, process/cgroup subject, provider-proof linkage, ordering and settlement API are not approved. Do not implement or activate terminal settlement in this work package.

WS3's current `ProcessStopReceiptV1` source is an unsigned semantic record with `scope=local_worker_process_tree`, exact process ID, cgroup ID, kill-request timestamp and kernel-observed `populated 0` timestamp. It establishes only a local worker process-tree observation. Before Control can consume it for settlement, WS3/W8 must define authenticated producer identity and a verifiable signed envelope, and W2 must verify exact workflow/task/claim/attempt/lease/owner-epoch/worker/observation lineage. Even a verified local stop receipt does not replace W4 provider terminal proof when a provider dispatch may have occurred.

### 3.7 `RecoveryQueryV1` — Control to W3/W4/W5/W7

**Coordinator:** WS2. **Observation owners:** W3, W4, W5, W7. **Status:** DRAFT; no cross-part inventory contract ratified.

Every query must identify the exact workflow/task/attempt/plan digest and, where issued, lease ID and owner epoch. Queries request read-only source-owned observations; they do not grant permission to inspect another deployable's private tables, database or filesystem.

Each owner must report its own subject-bound observation, source/service identity and generation, capture time/freshness, completeness and explicit result state. `UNKNOWN`, unavailable, stale, partial or mismatched responses remain unresolved. An absent row or omitted observation is not proof of process death, provider non-dispatch, session absence or artifact absence.

The existing local route `GET /v1/workflows/{workflow_id}/tasks/{task_id}/recovery` returns a local `TaskAttemptSnapshot` with `mutated: false`, disposition `UNRESOLVED`, authority `host_runtime_inventory_required`, exact lease/epoch/expiry, attempt ledger, provider/session observations, bounded journal, chain head and `history_complete`. It is read-only local inspection, not the distributed `RecoveryQueryV1` implementation.

### 3.8 `RecoveryDispositionV1` — verified recovery authority to Control

**Status:** BLOCKED; no schema candidate is asserted.

Terminal disposition requires a ratified issuer/verifier, complete authoritative source inventory, freshness/expiry and exact attempt/lease/owner-epoch fence, evidence composition, signer/key version, idempotency/replay, late-result/conflict behavior and atomic Control settlement. Until those requirements are approved and independently tested, disposition remains `UNKNOWN`/`UNRESOLVED`; no lease is released. A timestamp, timeout, missing row or local process exit cannot substitute for proof.

### 3.9 `GovernanceApprovalReceiptV1` and Control authorization projection — W6 to Control

**Producer:** WS6. **Consumer/decision transaction:** WS2. **Status:** DRAFT verifier/signature contract; production trust provisioning, durable nonce persistence, Control projection and revocation-to-commit freshness fence BLOCKED.

The current protocol foundation in `runalith-protocol/src/governance_v1.rs` declares `GovernanceApprovalRequestV1` / `GovernanceApprovalReceiptV1` version 1. The request carries `request_id`, `producer`, `audience`, `correlation_id`, `idempotency_key`, `subject`, `evidence_sha256`, opaque `authenticator`, `issued_at` and `expires_at`. `subject` carries `workflow_id`, `candidate_id`, `candidate_sha256`, `plan_sha256`, `source_snapshot_sha256` and `action_scope`. The receipt carries `decision_id`, `request_id`, Governance `producer`, Control `audience`, exact `subject` and `evidence_sha256`, `decision`, `policy_id`, `policy_version`, `policy_sha256`, `reviewer_subjects`, validity timestamps and opaque `authenticator`.

WS6 now supplies `GovernanceReceiptSignatureEnvelopeV1` as a closed `deny_unknown_fields` Ed25519 envelope. Its fields are `schema_version`, `kind=governance_approval_receipt`, `signature_algorithm=Ed25519`, `provider_id`, `scope`, host-bound `issuer`/`audience`, `key_id`, `trust_snapshot_ref_sha256`, `trust_root_sha256`, one-use `nonce`, issue/expiry times, request/subject/evidence/policy/receipt-payload digests, exact `receipt_payload`, and standard Base64 signature. The `kind` is the current domain-separation marker; WS6 must keep it fixed and versioned, not infer a generic signing context.

Digest/signature profile in the DRAFT implementation:

- receipt payload digest: `SHA-256(JCS UTF-8 receipt_payload)`;
- request digest: `SHA-256(JCS full GovernanceApprovalRequestV1 including its authenticator)`;
- subject digest: `SHA-256(JCS ApprovalSubjectV1)`;
- trust snapshot reference digest: `SHA-256(JCS six-field TrustSnapshotRefV1)`;
- Ed25519 signature preimage: `JCS complete typed signature envelope excluding only signature`;
- signed-envelope digest: `SHA-256(JCS complete envelope including signature)`.

`build_governance_receipt_authenticator_v1` receives a host-supplied `GovernanceReceiptSigningPort`, configured key/root, trust observer, issuer/audience/scope, nonce and time; it verifies the returned signature against the configured public root before returning it. `verify_governance_approval_receipt` parses the closed schema, pins issuer/audience/scope from host configuration, checks exact request/receipt/subject/evidence/policy/payload binding, exact trust snapshot, observed trust high-water and Ed25519 signature. This is substantive cryptographic implementation/test evidence, but the crate has no production private-key signer or production host wiring.

The separate `GovernanceReceiptNonceLedger` port binds `(nonce, signed_envelope_sha256, receipt_payload_sha256, request_sha256)` with `Consumed`, `ExactReplay`, `BindingConflict` and `Unavailable` outcomes. The supplied test adapter is process-local `Mutex` memory only. No durable independent-process/restart implementation is present. Signature/nonce verification currently does not commit the Control authorization projection; that remains WS2's transaction and ACK responsibility.

Control's required consumer verification, before it may treat `Approved` as authorization:

1. Authenticate the transport producer and require the exact configured Governance service identity; bind the receipt audience to the intended Control service identity. A claimed `producer` field is not authentication by itself.
2. Independently verify the receipt authenticator using the WS6 closed Ed25519 envelope and an approved Governance trust/configuration snapshot. Pin algorithm, key ID, issuer/key domain, trust-root/config snapshot, canonical JCS bytes, `kind` domain-separation marker and Base64 encoding. Do not treat the verifier's existence as production key provisioning or a successful `validate_for` call as signature verification.
3. Require receipt `schema_version`, `request_id`, producer/audience, subject, evidence digest and policy fields to match the exact outstanding request and Control's current workflow/candidate/plan/action/source-snapshot facts. Reject a receipt for a different workflow, candidate, plan, source snapshot, action, evidence, audience or policy version/digest.
4. Validate `issued_at`/`expires_at` against a trusted Control clock and the ratified maximum validity window. Define how a revocation/key-rotation race is fenced between Governance signing and Control consumption; a locally observed high-water cannot prove that no newer revocation exists.
5. Verify reviewer identities/versions, quorum and maker-checker semantics by trusting the canonical Governance decision, not caller-supplied reviewer strings. Control checks that the exact verified decision is applicable to the requested action; it does not re-evaluate or redefine global reviewer policy.
6. Consume the exact authenticated receipt and append the corresponding Control authorization/lifecycle reference in one Control-owned transaction. An exact duplicate returns the original receipt/outcome. Reuse of a request/idempotency/decision identity with changed subject, digest, policy or authenticator conflicts. A missing or ambiguous result remains `UNKNOWN`; do not grant admission or claim authority.

The protocol DTO's `validate_for` still checks structure, validity and exact request/subject/evidence binding but does not verify `authenticator`; the WS6 trust-crate verifier is a separate required call. WS6's Node fixture publishes exact request/receipt JSON, canonical unsigned signature-envelope bytes, Ed25519 signature, payload digest, trust-root fingerprint and trust-snapshot-reference digest. Changed-binding/same-nonce negative data is included. The fixture uses a generated test-only key and test configuration in the existing `execution_approval` domain/scope; it is not a production trust decision or selected production key/domain. The crate tests include successful Node-golden receipt verification, tampered audience/subject/snapshot/signature rejection, missing/stale trust observation, missing nonce ledger, exact replay, changed-binding conflict and 16-way concurrent exact nonce replay (1 `Consumed`, 15 `ExactReplay`).

Reviewed source/artifact snapshot in WS6's isolated uncommitted worktree: `governance_receipt.rs` SHA-256 `efca84b930f25add2802f2e67d4dbf90d62774fa02da13e87aea0bd972491db4`; `trust_snapshot.rs` SHA-256 `7c4554cdef25fbb7531ba11e51b113ad6d57a85cf4ebc47d1350dfd72c110d54`; Node fixture SHA-256 `3abfff2a5c7d7442341251ba1637cd32297bed31f1f84c9ac3da65d9cb076c5a`. WS6's subsequent addendum confirmed the `governance_receipt.rs` hash and superseded its earlier V2 request hash `daf4b037…`. No WS6 files were modified by WS2.

WS2 independently ran `cargo test --manifest-path rust/Cargo.toml -p runalith-trust --locked --offline` in the WS6 worktree: **69/69 PASS** (the WS6 request reported 68/68; current executed count is 69). `cargo fmt --manifest-path rust/Cargo.toml -p runalith-trust -- --check` and `cargo clippy --manifest-path rust/Cargo.toml -p runalith-trust --all-targets --locked --offline -- -D warnings` also PASS. These are isolated WS6 worktree tests; no code there was changed by WS2. W2 consumer disposition: `REVIEW_ACCEPTED_WITH_BLOCKERS` for the signed envelope, JCS/Ed25519 verification, exact bindings, high-water observation and nonce-port contract only. The verifier is DRAFT, not wired to a production Control host; production signing-key custody, durable nonce port, approved trust-domain/key configuration, Control projection, commit-before-ACK outbox/inbox and revocation-to-commit fencing remain BLOCKED.

WS6's `TrustSnapshotRefV1` binds schema version, domain, provider ID, scope, config version and full configuration fingerprint; its canonical-JSON reference digest is distinct from that fingerprint. The reference identifies configuration; it is not itself a high-water observation or proof the snapshot is still current/unrevoked. The verifier separately calls a `TrustConfigurationObserver` before signature acceptance. That observation is not yet transaction-bound to the later Control projection, so a revocation/configuration change can race between verification and commit unless the Project Owner-approved projection/fence closes it. WS6's `TrustConfigurationSet` still has five fixed trust domains and no trusted-skill authority domain. WS2 must not reuse `execution_approval` for skill trust or add a sixth root without explicit Project Owner/authority approval. W6 has not named an accountable human owner or selected a production signer/domain.

The separate Governance nonce-consumption and Control projection contracts must define:

- a durable one-use Governance receipt nonce ledger in its own domain, distinct from W7 checkpoint/source-verification nonces, with atomic exact replay and changed-binding conflict across restart and independent processes. WS6's current nonce port carries the full signed-envelope/payload/request digests but has only an in-memory test adapter; no separate signed `NonceConsumptionReceiptV1` is currently necessary if Project Owner approves the durable port boundary and its committed response semantics;
- the Control projection's source service identity, logical database identity, database generation/restore epoch, monotonic high-water version, digest/receipt lineage, signer/key version, issue/expiry bounds and revocation state;
- a durable Governance outbox and Control inbox, exact event/request identities, idempotency key, duplicate/conflict replay, ACK only after the Control transaction commits, and reconciliation after timeout/crash;
- freshness and revocation ordering: bind the exact observed high-water/version to the Control transaction or use bounded staleness, a signed short-lived authorization lease, synchronous freshness check, or another Project Owner-approved fence. The current observer verifies configuration was observed but is not transaction-coupled to Control commit; a high-water projection alone does not establish instantaneous revocation visibility;
- the explicit `UNKNOWN` behavior when Governance is unavailable, delivery is ambiguous, source generation changes, a version gap appears, or the signer/key/configuration cannot be verified.

Do not add a network call inside the current SQLite approval transaction and do not directly query Governance storage. Fetch authenticated evidence before the Control transaction; verify and consume the exact signed/versioned evidence with the approved local projection inside that transaction. No cross-database ACID transaction is implied. D-01 supersession, projection consistency and independent DB ownership remain separate Project Owner gates.

### 3.10 `WorkflowPlanAttachmentV1` / task adapter — WS1 to Control

**Producer:** WS1 (`CompiledPlanV1`). **Consumer/adapter owner:** WS2. **Status:** DRAFT; no W2 public DTO or persistence event is ratified.

The producer clarification reviewed for this candidate identifies the immutable task key as `task_id + role_id + role_version`; each compiled task also binds `depends_on`, `input_contract` and `output_artifact_type`. The W1 compiler returns a new immutable plan when `with_policy_composition` is applied; that operation verifies the composition and recalculates the outer digest but does not persist/attach policy to a live workflow instance. WS2 owns the adapter DTO, instance binding, append-only attachment event, idempotency/replay/conflict behavior and journal ordering.

Proposed W2 adapter DTO (logical fields; exact Rust/JSON type names and serialized schema await W1/W8 review):

| DTO | Field | Meaning |
|---|---|---|
| `WorkflowPlanAttachmentV1` | `schema_version` | Explicit W2 adapter schema version; candidate value `1`. |
| `WorkflowPlanAttachmentV1` | `workflow_id` | Existing Control workflow-instance identity. It is not inferred from the catalog slug. |
| `WorkflowPlanAttachmentV1` | `catalog_workflow_id`, `workflow_version` | Exact W1 `WorkflowDefinitionPinV1` identity/version. Keep distinct from Control `workflow_id`. |
| `WorkflowPlanAttachmentV1` | `plan_sha256` | `CompiledPlanV1.plan_digest.value` after `verify_digest()`; exact lowercase SHA-256 outer digest. |
| `WorkflowPlanAttachmentV1` | `task_bindings` | Complete one-to-one mapping from Control task rows to immutable W1 compiled tasks. |
| `WorkflowPlanTaskBindingV1` | `control_task_id` | Stable Control task-row identity. |
| `WorkflowPlanTaskBindingV1` | `workflow_plan_task_id` | Exact `CompiledWorkflowTask.task_id` from the immutable W1 plan. |
| `WorkflowPlanTaskBindingV1` | `role_id`, `role_version` | Exact immutable W1 role identity/version; never reconstructed from display text. |
| `WorkflowPlanTaskBindingV1` | `depends_on` | Exact ordered predecessor task IDs from W1 plan and Control task projection. |
| `WorkflowPlanTaskBindingV1` | `input_contract`, `output_artifact_type` | Exact W1 typed artifact contract; no lossy coercion from free-form task metadata. |

Adapter requirements:

1. Verify the entire `CompiledPlanV1` outer and inner digest before mapping. Pin the exact `catalog_workflow_id`, workflow version and plan digest to the Control workflow instance through an append-only Control event. Keep catalog identity/version separate from the Control job/workflow ID.
2. Require exactly one binding for every compiled task and exactly one compiled task for every binding. `control_task_id` and `workflow_plan_task_id` must be non-empty, unique in their respective domains and explicitly related; no ordinal/array position, task description or role label can establish identity.
3. Resolve each `workflow_plan_task_id` to exactly one `CompiledWorkflowTask`. Compare `role_id`, `role_version`, `depends_on`, `input_contract` and `output_artifact_type` exactly against the authenticated Control task row/projection. Missing, duplicate, unknown or changed fields reject the entire attachment atomically.
4. The legacy Node custom-plan role string `custom-task-N` is a positional compatibility/display alias only. It is neither `task_id` nor `role_id`; do not parse N or use role lookup to infer a plan task. The current Rust compatibility adapter derives the Control `TaskSpec.task_id` from the compiled task ID and stores `custom_role_id`, `custom_role_version`, typed I/O and dependencies in the task inputs, but this local derivation is not a frozen public W2 DTO.
5. Do not treat a synthetic role alias, missing binding, matching task count, or same task ordinal as proof. Do not join on role alone: multiple tasks may use the same role/version. Do not accept extra Control tasks outside the immutable plan or omitted plan tasks.
6. Preserve the complete immutable plan digest with all bindings. Any changed plan, role version, dependency, typed input/output or policy composition creates a distinct plan digest and explicit W2 lifecycle event; never rewrite a previously attached/approved plan in place.
7. W1's `PolicyPlanContextV1::from(&CompiledWorkflowPlan)` sets `executor=None`. Control must pass a separately authenticated executor identity when evaluating an `execution_exit_code_equals` predicate. `deterministic=true`, role label or task metadata must never synthesize or authorize `ExecutionManager` identity.

The current Node compatibility oracle at `src/runtime/workflow-state-port.js` requires an explicit `workflow_plan_task_id`, exact ID+role binding and exact dependency comparison for planned execution. The W2 adapter must preserve that fail-closed behavior while replacing positional role inference with W1's canonical task/role identity. The exact interaction with non-catalog legacy tasks must remain explicit: an unbound legacy proposal is not silently promoted into a `CompiledPlanV1` task.

### 3.11 `WorkflowPolicyAttachmentEventV1` — live instance attachment owned by WS2

**Producer of immutable composition:** WS1. **Owner of live workflow attachment:** WS2. **Status:** DRAFT; lifecycle transition and persisted event schema not frozen.

`WorkflowPolicyCompositionV1` and its policy pins are inputs to a new immutable `CompiledPlanV1`; they are not, by themselves, an attachment to a live workflow. The W2 event candidate must bind the Control workflow ID, prior plan digest (when replacing a previously attached revision), new complete plan digest, exact policy pins/snapshot digests, authenticated actor, stable event ID, idempotency key, correlation/causation IDs, `expected_prior_sequence` and `expected_prior_head_sha256`. The committed event's resulting sequence and predecessor event ID are separate outputs; neither is the expected prior CAS value.

Control validates lifecycle eligibility and the caller's `expected_prior_sequence` plus `expected_prior_head_sha256` against the current workflow journal head in one Control-owned transaction, then appends the event and updates the projection atomically. An exact replay returns the original receipt and does not attach twice. Reusing the event/idempotency identity with changed actor, workflow, prior/new plan digest, policy pins or expected head conflicts. An unexpected current plan/journal head is a stale-write conflict, not an invitation to overwrite. A policy change is a new immutable plan revision; never mutate policy semantics attached to an already approved/executing instance. The exact allowed lifecycle states/reapproval transition must be ratified against the Node lifecycle oracle before implementation.

## 4. Error and ordering semantics

The candidate domain distinctions are:

- authentication failure is distinct from authorization denial;
- malformed or unsupported schema is distinct from a valid but stale subject;
- `STALE_OWNER` is a durable rejection of an obsolete fence, not an accepted result;
- same identity + same digest is an exact replay; same identity + changed digest/subject is conflict;
- authority unavailable, missing evidence, incomplete history or ambiguous external effects remain `UNKNOWN`/`UNRESOLVED`;
- service unavailability must fail closed; the standalone compatibility host currently returns `503` for worker routes when authority is missing.

These are semantic categories, not final HTTP/status-code or error-code assignments. WS8 must review the wire mapping and publish exact code strings, response schemas and compatibility fixtures. Producers must not collapse `UNKNOWN` into retryable `NOT_SENT`, false, absence or terminal failure.

Control's internal lifecycle journal has a per-workflow monotonic sequence, stable event ID, optional task ID, event type/payload, UTC creation time, previous digest and current digest. The exact canonicalization profile, public event DTO, retention/read pagination and cross-part predecessor semantics still require contract fixtures and review. A consumer must not infer ordering from wall-clock time.

### 4.1 W8 Common Envelope v1 crosswalk — DRAFT

The W8 v1 draft is useful transport shape, not a ratified W2 DTO or route. Candidate field mapping, subject to WS8 schema review and W2 approval:

| W8 envelope field | W2 mapping | Non-equivalence / validation |
|---|---|---|
| `schema_version` | Explicit common-envelope major/minor range negotiated by the authenticated service pair. | Separate from every inner W2 payload `schema_version`; reject unsupported negotiated minor at runtime. |
| `message_kind`, `message_type` | Claim response: `response`; lease renewal/cancellation/command: `command`; result delivery: `event` only if the final Control inbox API ratifies it. | Exact type vocabulary and result command-vs-event choice remain DRAFT. |
| `message_id` | Immutable identity of this common-envelope message; unchanged across exact-byte retries. | Not W2 `request_id`, `event_id`, `claim_id`, `renewal_id`, receipt ID or idempotency key. |
| `producer_id` | Host-authenticated producer service identity from transport/service authentication. | Not a caller-supplied `issuer`, `producer`, `worker_id` or principal string in JSON. Compare inner claims with authenticated transport context; do not treat them as authentication. |
| `correlation_id`, `causation_id` | Preserve origin trace; response `causation_id` identifies the exact envelope message that caused the response. | Distinct from domain request/event/receipt identities unless an approved producer rule explicitly binds them. |
| `effect_class` | Derived from an approved route registry: read-only for workflow/recovery reads; mutating for command, renewal and cancellation; result delivery classification pending route/inbox approval. | Caller declaration is never authorization. No public W2 route is approved. |
| `idempotency_key` | Forward the exact domain operation key unchanged; for renewal this is the stable `renewal_id`. | Not `message_id`, `claim_id`, `event_id` or any other operation's idempotency scope. |
| `subject` | Candidate task message: `kind=task`, `id=task_id`; bindings include `workflow_id`, `plan_sha256`, `attempt`, `lease_id`, `owner_epoch` and any producer-required worker/claim identity. Workflow-level commands/reads use exact workflow subject. | Subject is not a replacement for the full payload, signature, current fence or authorization check. |
| `payload_digest` | SHA-256 over exact immutable W2 payload bytes under a named W2/W8-approved canonicalization profile. | Never copy `plan_sha256`, `command_sha256`, `acl_sha256`, `event_sha256`, previous/current journal digest, receipt signature or artifact hash into it unless bytes/domain are proven identical. |
| `ordering.stream_id` | Exact Control `workflow_id` for the per-workflow journal stream. |
| `ordering.sequence` | Resulting monotonic W2 `WorkflowEvent.sequence` after commit. |
| `ordering.predecessor_id` | Previous event's `WorkflowEvent.event_id`, derived only from the verified immediately preceding sequence; `null` for first event. | It is an event identity, not a digest. It is not W2 `previous_sha256`. |
| payload `previous_sha256` / `sha256` | Preserve W2 previous/current journal digests as distinct producer-owned fields when the W2 event projection is in the payload. | W8 schema v1 has no typed predecessor-digest member. Do not overload `ordering.predecessor_id`; a future envelope revision may add a separate typed digest only after W2/W8 review. |
| payload `expected_prior_sequence` / `expected_prior_head_sha256` | Required optimistic-CAS expectations for a cross-part state-changing request/event append where stale writes must be rejected. | These are pre-commit expectations, not the resulting `ordering.sequence` or predecessor ID; the check and append must be one Control-owned transaction. |

The current W2 Store has a more specific local journal profile: `insert_event` serializes the payload with `serde_json::to_string`, selects the current last `event_hash` under the caller's immediate transaction (or uses 64 ASCII zeroes for genesis), then hashes `serde_json::to_vec(EventHashMaterial)` with SHA-256. `EventHashMaterial` fields, in serde struct order, are `workflow_id`, `event_id`, optional `task_id`, `event_type`, the serialized `payload_json` string, `idempotency_key`, `created_at` and `previous_hash`. `event_seq` is a SQLite autoincrement sequence and is not included in `EventHashMaterial`. Candidate vectors in `02-control-journal-v1.fixtures.json` pin two exact byte strings and hashes; `02-control-journal-v1-test.py` verifies their UTF-8 bytes, lengths, SHA-256 and predecessor/sequence distinctions. The vectors were generated with an isolated Rust helper using the same `serde_json`/`sha2` versions as the current workspace, not by calling private `runalith-store::hash_event`; they are reproducible compatibility evidence but remain DRAFT until producer-owned tests and owner approval ratify the cross-language profile.

The current W2 `WorkflowEvent` projection exposes resulting sequence, `event_id`, `previous_sha256` and current `sha256`, but no predecessor-event-ID field or expected-prior-sequence request field. The W2 cross-part command/event candidate therefore separates four values: (1) caller's `expected_prior_sequence` and `expected_prior_head_sha256` as optimistic-CAS inputs; (2) resulting `ordering.sequence` as the committed event's sequence; (3) `ordering.predecessor_id` as the immediately preceding event ID (null for genesis); and (4) W2 payload `previous_sha256` / `sha256` as the digest-chain fields. These are never interchangeable. Current generic `insert_event` serializes append in an immediate transaction but does not accept a public caller-provided expected prior sequence/head; a future W2 route must check both expected values against the current workflow head before state change and append in the same Control-owned transaction. `sequence` for the first event is 1, `predecessor_id` is null and payload `previous_sha256` is 64 zeroes. A prior event ID can be emitted only if the exact previous row and its digest chain are verified. If history is truncated, sequence has a gap, or prior row cannot be verified, do not assert ordered continuity; preserve `UNKNOWN`/`UNRESOLVED`.

W8's current draft `ordering.predecessor_id` is an opaque nullable string, so this crosswalk is representable without treating it as a digest. The W2 `previous_sha256` mapping remains payload-owned; `expected_prior_sequence` and `expected_prior_head_sha256` are request payload fields. The `McpServiceRequestV1` / response inner integer version also remains distinct from common-envelope major/minor.

W8 has supplied an isolated std-only `SupportedVersionRange` candidate in `rust/workstreams/08-version-negotiation.rs` (WS8 worktree source SHA-256 `f21cd14473c975e188fd82b81ef4849516f42c0fb00dcab98bc0d7cd58b9bf37`). Its `validate_inbound` checks exact major and inclusive minor bounds before dispatch; `negotiate` selects the greatest common minor and fails closed on disjoint ranges. The current draft constant supports only envelope v1.0. WS2 independently compiled and ran its standalone test module: 8/8 PASS. This is a useful DRAFT primitive, not runtime behavior: it is not integrated into Gateway request dispatch, while the JSON Schema structurally accepts any non-negative minor (including 99). Negotiated-version enforcement in the live Gateway remains NOT PROVEN.

W2 `TaskClaimV1` must be issued as a response caused by the exact claim request message; its inner `claim_id` and issuance idempotency key stay in payload. `LeaseRenewalV1` uses envelope `idempotency_key=renewal_id`; response causation binds the original renewal message. `TaskResultEnvelopeV1` remains event-vs-command DRAFT until the exact Control inbox API is selected. Cancellation ACK is only a response to intent; it is not the W3 process-stop receipt or W4 provider terminal proof. `RecoveryDispositionV1` has no route/message mapping until its authority is ratified.

No route metadata, remote service identity, principal provisioning or mutation API is approved by this crosswalk. W8 source tests cover envelope structure, not W2 domain mapping or host authentication.

## 5. Required negative and fault-injection cases

At minimum, contract compatibility tests must reject or preserve unresolved for:

1. claim with wrong workflow/task/plan/command digest, worker audience, attempt, lease ID, owner epoch, ACL digest or expired deadline;
2. renewal with wrong worker/attempt/lease/epoch, expired lease, changed payload under the same renewal ID, or exact replay that would otherwise extend twice;
3. result with stale owner, changed event digest under the same event ID/idempotency key, duplicate exact event, delayed event, predecessor gap or wrong producer;
4. cancellation of executing work that releases a lease or terminalizes on request ACK, timeout, local exit or late result alone;
5. approval receipt with wrong workflow/candidate/plan/action/audience/version, missing signer, stale high-water, expired/revoked key, replayed nonce or unavailable Governance authority;
6. recovery response with wrong source identity/generation, stale capture time, incomplete inventory, missing lease/session/provider evidence or ambiguous provider outcome;
7. any code path treating absent evidence as `Absent`, worker death, `NOT_DISPATCHED`, success, zero or false;
8. direct SQL/private-file access across deployables or an implied cross-database ACID transaction;
9. unknown schema version, duplicate JSON keys, oversized body, ambiguous transport framing or unsupported digest profile;
10. crash/reopen after inbox persistence, exact replay, changed-digest conflict, duplicate/out-of-order delivery and independent-connection races.

For `WorkflowPlanAttachmentV1`, additionally reject: missing `workflow_plan_task_id`; duplicate control or plan task binding; unknown extra plan/control task; task ID mismatch; wrong role ID or role version; dependency order/content mismatch; typed input/output mismatch; plan outer/inner digest mismatch; catalog workflow/version mismatch; attempted identity inference from `custom-task-N` or array position; and deterministic policy evaluation without an authenticated executor identity.

Existing Rust and Node test suites already cover many local compatibility/transaction cases. The exact cross-part vectors, independently deployed stores and production authority are not proven by those tests.

## 6. Current implementation/evidence mapping

| Area | Current artifact/evidence | Limit |
|---|---|---|
| Worker routes, auth/capabilities, claim/renew/result adapter and fail-closed behavior | `rust/crates/runalith-control-api`; `rust/docs/worker-control-api-v1.md` | `WorkerControlAuthority` is not injected by standalone host; worker routes return `503`. Adapter tests do not prove server-side fencing. |
| Cancellation request and read projection | `rust/crates/runalith-control-api`; `rust/crates/runalith-store` | Compatibility Store request persistence only; executing settlement remains `UNRESOLVED`. |
| Read-only recovery | `rust/crates/runalith-control-api`; `rust/crates/runalith-recovery`; `rust/docs/control-operations.md` | Local snapshot only; no authoritative cross-part terminal disposition. |
| Claim/lease/journal/result inbox/idempotency/CAS | `rust/crates/runalith-store` | Store schema v20 is a mixed compatibility aggregate, not a Control-only DB. |
| Lifecycle oracle | Node tests listed below; shared `runalith-domain` fixtures | W1/W2 share `runalith-domain`; passing tests do not establish ownership split. |
| Compiled-plan adapter proposal | `02-compiled-plan-adapter-v1.fixtures.json`; executable isolated check `02-compiled-plan-adapter-v1-test.py` | W1 one-task and two-task Node canonical vectors; second vector has repeated `custom-owner@1` and dependency edge. Candidate attachment maps Control-owned IDs explicitly to W1 task IDs. Executable fixture test reports 2 positive + 17 negative checks; not production Rust persistence. |
| Worker/cancellation boundary review corpus | `02-control-boundary-v1.fixtures.json` | Logical DRAFT examples and 24 negative cases. Not a JSON Schema, not executable by itself, and not golden canonical bytes/signature; positive authority verification is intentionally absent. |
| Control event journal profile | `02-control-journal-v1.fixtures.json`; executable isolated check `02-control-journal-v1-test.py` | Two exact serialization vectors (389 and 380 material bytes) pass Python byte/hash comparison. The test does not directly invoke the private Store function; profile remains DRAFT. |

Validation rerun on 2026-11-03 in the current shared working tree:

| Command | Result |
|---|---|
| `cargo test --manifest-path rust/Cargo.toml -p runalith-control-api --locked --offline` | PASS — 26 library + 8 binary + 11 standalone-process = 45 tests; exit 0. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-recovery --locked --offline` | PASS — 15 tests; exit 0. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-domain --locked --offline` | PASS — 56 tests; exit 0. Shared W1/W2 package. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-store --locked --offline -- --test-threads=1` | PASS — 99 tests; exit 0. Shared schema-v20 compatibility Store, not an extracted Control DB. |
| `node --test tests/test-workflow-m4.js tests/test-task-lease-manager.js tests/test-task-lease-expiry-race.js tests/test-workflow-terminal-failure-atomicity.js tests/test-distributed-scheduler.js tests/test-phase5-recovery.js tests/test-phase5e-recovery.js tests/test-execution-lease-fencing.js` | PASS — 8 files, 8 passed, 0 failed; exit 0. |
| `cargo fmt --manifest-path rust/Cargo.toml --all -- --check` | PASS; exit 0. |
| `cargo clippy --manifest-path rust/Cargo.toml -p runalith-control-api -p runalith-recovery -p runalith-domain -p runalith-store --all-targets --locked --offline -- -D warnings` | PASS; exit 0. |
| `cargo check --manifest-path rust/Cargo.toml --workspace --locked --offline` | PASS; exit 0. |
| `cargo test --manifest-path rust/Cargo.toml -p runalith-trust --locked --offline` (WS6 isolated worktree) | PASS — 69/69 tests; exit 0. WS6 worktree, not WS2-owned source. |
| `cargo fmt --manifest-path rust/Cargo.toml -p runalith-trust -- --check` (WS6 isolated worktree) | PASS; exit 0. |
| `cargo clippy --manifest-path rust/Cargo.toml -p runalith-trust --all-targets --locked --offline -- -D warnings` (WS6 isolated worktree) | PASS; exit 0. |
| `python3 -c 'import json; json.load(open("rust/workstreams/02-compiled-plan-adapter-v1.fixtures.json"))'` | PASS; fixture JSON parses. This is syntax validation only, not behavioral test. |
| `python3 rust/workstreams/02-compiled-plan-adapter-v1-test.py` | PASS — 2 positive + 17 negative checks; exit 0. Isolated fixture contract test, not production adapter execution. |
| `python3 -c 'import json; json.load(open("rust/workstreams/02-control-boundary-v1.fixtures.json"))'` | PASS; fixture JSON parses. Logical review corpus only; not a cryptographic or runtime acceptance test. |
| `python3 rust/workstreams/02-control-journal-v1-test.py` | PASS — 2 exact hash vectors plus ordering/predecessor separation; exit 0. Standalone fixture serialization, not a direct Store call. |

These results establish local test/build/lint evidence only. They do not establish cross-part ratification, production claim authority, terminal cancellation settlement, terminal recovery disposition, cross-store retry/takeover, independent Control DB ownership, or three-deployable release/rollback.

## 7. Review and ratification gates

| Reviewer/authority | Required review | Current status |
|---|---|---|
| WS1 | `CompiledPlanV1`, plan digest/canonicalization, typed DAG/task command mapping and policy attachment | `REVIEW_ACCEPTED_WITH_BLOCKERS`; W1 supplied two-task repeated-role/dependency golden vector (1,209 bytes, SHA-256 recorded in fixture). W2 executable mapping check added; live Control attachment remains unimplemented/unratified. |
| WS3 | Task claim consumer, stable renewal ID/receipt, process observation and stop-proof boundary | WS3 V6 review `ACCEPTED_WITH_BLOCKERS`; V4/V5 feedback and heartbeat clarification incorporated. Current heartbeat fails closed; no same-heartbeat retry today; future caller-owned exact retry ID/complete receipt remains NOT PROVEN. Latest exact-hash re-review pending. ACL digest placement, authenticated process-stop proof and named owners remain blockers. |
| WS6 | Signed approval receipt and high-water projection, freshness/revocation/nonce/replay | WS2 consumer review `REVIEW_ACCEPTED_WITH_BLOCKERS` for DRAFT Ed25519/JCS builder/verifier semantics, exact golden receipt and nonce-port shape. 69 crate tests + fmt + Clippy PASS; actual source SHA `efca84b9…72491db4` confirmed by WS6 addendum. Production private-key signer/provisioning, selected trust domain/key, durable nonce adapter, Control projection/commit-before-ACK, revocation-to-commit fence, W6 accountable owner and D-01 authority remain BLOCKED. |
| WS7 | Evidence/attestation reference and source lineage/verification boundary | DRAFT; producer-owned generic source verification DTO and independent authority evidence required. |
| WS8 | Envelope, principal/request/message/service/causation mapping, digest profiles, routes and error/UNKNOWN mapping | WS8 V6 review `ACCEPTED_WITH_BLOCKERS` for field mapping/schema ordering only; V4/V5 review also accepted with blockers. Updated journal CAS/sequence/predecessor mapping, exact journal vectors and isolated version-negotiation test are recorded in §4.1; latest exact-hash re-review pending. Other W2 DTO canonical-byte vectors, integrated runtime negotiation, routes and service authentication remain unproven. |
| Project Owner / accountable domain owners | Named ownership, decision authority, same-version approvals and source revision | UNASSIGNED / NOT PROVIDED. |

The current A2A protocol restricts WS2 to the directed review edges above. WS2 does not send directly to WS4/WS5 without an approved graph/ACL change; their domain facts are consumed through their producer-owned public ports and coordinated through the authorized edges.

No line in this document is RATIFIED. Ratification requires immutable producer-owned revisions, consumer review against the same exact revision, named accountable owners/authority, explicit approval and acceptance evidence. A queued message, received message, transport ACK, local build or green unit suite is not approval.

## 8. Explicitly blocked operations

Do not perform or claim completion of:

- production `WorkerControlAuthority` injection, production claim signing or trust/key provisioning;
- cross-part cancellation settlement or lease release;
- authoritative terminal recovery disposition;
- same-task cross-deployable retry/takeover or cross-store atomicity;
- D-01 database split/projection/copy/migration/cutover or writer-barrier change;
- production provider dispatch, deployable release, deployment or cutover.

These require Project Owner and authority-owner decisions plus exact signed/versioned contracts and independent end-to-end evidence. Fail-closed denial/`503` is expected while those gates remain open.
