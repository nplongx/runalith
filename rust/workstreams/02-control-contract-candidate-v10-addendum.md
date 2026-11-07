# WS2 Control contract candidate — V10 addendum

**Status:** DRAFT / PROPOSED / NOT RATIFIED.  
**Base candidate:** `02-control-contract-candidate-v1.md`, SHA-256 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5` (reviewed as V9).  
**Purpose:** immutable successor addendum for new WS1/WS3/WS6/WS8 review feedback. The base candidate remains unchanged. V10 means the exact base candidate plus this addendum; do not treat it as a frozen deployment schema.

This addendum records producer/consumer review dispositions and proposes further WS2-owned semantics. It does not authorize source, schema, database, manifest, route, credential, deployment, migration or cutover changes.

## 1. V10 source/review lineage

| Input | Exact evidence | Disposition |
|---|---|---|
| WS1 `CompiledPlanV1` review | WS1 A2A seq 399, message `2b332014-ed9c-4bbd-bda2-ac589a13d22c` | `REVIEW_ACCEPTED` for plan/task mapping only. |
| WS3 claim/lease review | WS3 seq 366, message `63992839-ae15-4f43-9c04-ed189fb05ec6`; follow-up seq 402, message `d8693614-e915-4038-9d8c-f307d85d5044`; feasibility seq 414, message `bd357e47-2873-41da-b91f-130a0335f1bb` | `ACCEPTED_WITH_BLOCKERS`; V10 proposal feasible with versioned implementation, but no golden bytes or owner ratification. |
| WS3 result/observation mapping | WS3 seq 378, message `e2471287-1efa-44ac-b929-e4441d8b2642`; disposition ACK seq 403 | `REVIEW_ACCEPTED_WITH_BLOCKERS`; DRAFT only. |
| WS6 Governance receipt review | WS6 seq 433, message `36762a52-e214-41d6-9c0c-fd7ddc21429f` | `REVIEW_ACCEPTED_WITH_BLOCKERS`; producer hash/test evidence updated; nonce persistence and Control projection gates remain open. |
| WS8 transport crosswalk | WS8 seq 418, message `b18d0ac5-61aa-45a6-b77b-73bf32458a60` | `ACCEPTED_WITH_BLOCKERS` for transport crosswalk only; DRAFT, no envelope/route ratification. |
| WS1 handoff review | WS1 seq 428, message `30e567d7-9389-4403-ae1d-87bfed112909` | `RECEIVED_AND_REVIEWED`; confirms mapping-only acceptance and WS7 ACL asymmetry. |

The A2A replies/ACKs do not appoint accountable owners or grant authority. WS2, WS1, WS3, WS6, WS7 and WS8 briefs still identify accountable owners as UNASSIGNED.

## 2. `TaskClaimV1` and execution-fence successor requirements

WS3 confirms the V10 shape is feasible subject to versioning and golden vectors.

1. The next claim payload version should expose `acl_sha256` as an explicit top-level field. It is included in the complete canonical signed claim bytes. Do not infer that a field nested in an untyped `authenticator: Value` was covered by the V3 typed claim DTO.
2. Proposed worker payload version is `TaskClaimEnvelopeV4`. Preserve the V3 parser and semantics; never silently deserialize V4 as V3. The V4 structural validator requires a lowercase 64-character SHA-256 ACL digest.
3. The signature verifier must bind issuer, audience, issued/expiry times, claim/workflow/task, attempt, lease, owner epoch, worker, plan digest, command digest, ACL digest and exact nested W4 provider-dispatch/W5 session-message bytes.
4. `attempt` is a first-class authenticated field in the Control claim and execution-fence subject. A digest of the full `ProviderDispatchRequest` including attempt is supplemental and must be recomputed against W4's durable intent; it does not replace the explicit Control attempt fence.
5. Proposed `ExecutionFenceV2` carries attempt in both request and response. Existing V1 journal rows require an explicit versioned compatibility rule; ambiguous or incomplete old rows remain unresolved rather than having attempt inferred.

**Source ownership:** V4 claim parsing/validation, Worker execution-fence DTOs, Control HTTP mapping and WorkerStore journal compatibility are WS3-owned files. WS2 must not edit those files or approve a WorkerStore schema migration.

**Required before source implementation/ratification:** exact canonicalization/serde profile, positive and negative canonical bytes/signature vectors, nested W4/W5 digest rules, ExecutionFenceV2 request/response vectors, V1 journal compatibility rules, and named WS2/WS3 accountable owners.

## 3. `LeaseRenewalV1` exact-retry candidate

Proposed request fields: `schema_version`, `renewal_id`, `claim_id`, `workflow_id`, `task_id`, `lease_id`, `worker_id`, `attempt`, `owner_epoch`, `lease_seconds`.

The caller durably records one immutable logical heartbeat ID and exact request before first send. Retrying that same heartbeat reuses the same ID and exact request bytes. A later heartbeat gets a new ID. Control atomically checks the exact current, unexpired claim/lease/worker/attempt/epoch before applying or replaying.

Proposed durable receipt fields: `receipt_id`, `renewal_id`, `claim_id`, `workflow_id`, `task_id`, `lease_id`, `worker_id`, `attempt`, `owner_epoch`, `previous_expires_at`, `expires_at`, `persisted_at`.

- Exact replay returns the original receipt and original expiry; it does not extend a second time.
- Same `renewal_id` with changed body or subject is `IDEMPOTENCY_CONFLICT`.
- Stale/expired/superseded owner is rejected; renewal never resurrects a lease.
- Missing or ambiguous receipt remains `UNKNOWN`; do not allocate a new ID to disguise a retry.

WS3 reports that current `ControlPlane::renew_lease` lacks caller-owned `renewal_id` and same-request retry; the current `LeaseRenewal` omits full durable receipt fields. A durable WorkerStore request/receipt journal or schema version may be required. No such migration is authorized.

## 4. Process-stop and provider-terminal separation

Keep `ProcessStopReceiptV1` an unsigned, local `local_worker_process_tree` cgroup/process observation. It proves neither remote provider terminality nor no-more-side-effects. Do not reuse `GovernanceApprovalReceiptV1` as a generic process-stop receipt.

A future cross-host stop attestation requires a separately approved host identity/trust policy, exact signed payload, audience, key lifecycle/revocation, freshness, replay and producer-verification rules. It must bind workflow/task/claim/attempt/lease/owner-epoch/worker plus observation/manifest/process/cgroup/timing/scope. WS2 verifies only against an authority contract approved by its owner; W3 owns local process facts; W4 owns provider terminal proof. Cancellation settlement still requires the separate W4 proof whenever provider dispatch may have occurred, and an atomic Control settlement CAS under the exact current fence.

## 5. Governance receipt consumer addendum

Latest WS6 producer evidence received in seq 433:

| Artifact | SHA-256 |
|---|---|
| `rust/crates/runalith-trust/src/governance_receipt.rs` | `54a9822e7715840daf51538ffe049172d8fcbca430a37cca17be9fd051fad6ba` |
| `rust/crates/runalith-trust/src/trust_snapshot.rs` | `7c4554cdef25fbb7531ba11e51b113ad6d57a85cf4ebc47d1350dfd72c110d54` |
| Node Governance receipt fixture | `3abfff2a5c7d7442341251ba1637cd32297bed31f1f84c9ac3da65d9cb076c5a` |

WS2 independently reran the current WS6 crate:

- `cargo test --manifest-path rust/Cargo.toml -p runalith-trust --locked --offline`: **72/72 PASS**.
- `cargo fmt --manifest-path rust/Cargo.toml -p runalith-trust -- --check`: PASS.
- `cargo clippy --manifest-path rust/Cargo.toml -p runalith-trust --all-targets --locked --offline -- -D warnings`: PASS.

The nonce port includes process-local mutex and `#[cfg(test)]` SQLite adapters. The SQLite test uses independent connections and adapter reconstruction over one temporary file; this is test evidence, not a production persistence adapter or owner decision.

WS6's reviewed Control projection recommendation is recorded as DRAFT: Control may persist an immutable projection/reference containing request/idempotency ID, decision ID, exact receipt/signed-envelope/payload digests, exact workflow/candidate/plan/source-snapshot/action subject, evidence/policy digests and decision, authenticated issuer/Control audience, trust domain/config version/snapshot reference/key/root fingerprints and issue/expiry. Control alone assigns its local logical DB ID, generation, restore epoch, high-water and projection sequence. Do not store Governance private keys, root PEMs, mutable Governance policy tables or nonce rows as Control truth. Preserve exact signed receipt bytes or an immutable retrievable reference for audit/revalidation.

WS6 owns nonce-domain semantics; durable persistence owner and atomic boundary remain UNASSIGNED. A Governance-owned durable consume before Control commit is not atomic with projection; a Control-side nonce write changes the persistence boundary and requires owner approval. No cross-database ACID is assumed. Observer high-water is not transaction-bound to Control commit; revocation-to-commit race remains OPEN pending a Project Owner-approved freshness fence. Do not add network calls inside the Control transaction or read Governance tables directly.

## 6. Stable WS2 domain error vocabulary — PROPOSED

WS2 owns producer-domain error meaning and stable code strings. W8 owns wire representation/HTTP mapping and must not invent producer semantics. The following proposal distinguishes codes already present in the Node lifecycle oracle from new cross-part candidate codes.

### 6.1 Existing Node oracle codes (observed, do not rename)

| Code | Exact observed meaning |
|---|---|
| `ILLEGAL_ACTIVE` | Node job transition rejects an illegal active-state transition. |
| `TERMINAL_REOPEN` | Node job transition rejects reopening a terminal state. |
| `INVALID_PHASE_TRANSITION` | Node workflow phase transition rejects an invalid phase edge. |

These are exact fixture values from `rust/crates/runalith-domain/tests/fixtures/node-workflow-lifecycle-v1.json`; the corresponding Rust compatibility tests assert them. This addendum does not claim new HTTP mappings.

### 6.2 New candidate codes (DRAFT; require fixtures and owner review)

| Proposed code | Producer-domain meaning |
|---|---|
| `AUTHENTICATION_FAILED` | Host-authenticated caller/service identity could not be established. Distinct from capability/policy denial. |
| `AUTHORIZATION_DENIED` | Principal is known but lacks the required capability/action authority. |
| `MALFORMED_REQUEST` | Request violates closed DTO syntax, required-field or canonical-value constraints. |
| `UNSUPPORTED_SCHEMA_VERSION` | Inner producer DTO version is unknown or incompatible; outer envelope version is a separate W8 concern. |
| `SUBJECT_MISMATCH` | Validly parsed message/receipt binds a different workflow/task/plan/action subject. |
| `STALE_OWNER` | Attempt, claim, lease, worker or owner epoch is no longer current. Durable rejection; never accepted result. |
| `IDEMPOTENCY_CONFLICT` | Existing event/request/renewal identity is reused with different canonical subject or content digest. |
| `STALE_WORKFLOW_HEAD` | Expected prior sequence/head CAS does not match current committed Control journal head. |
| `ORDERING_GAP` | Required source sequence/predecessor is missing, gapped or conflicting. Preserve `UNKNOWN`/`UNRESOLVED`; do not sort by timestamp. |
| `AUTHORITY_UNAVAILABLE` | Required authenticated Governance/claim verifier or trusted authority snapshot cannot be obtained/validated. |
| `EVIDENCE_UNRESOLVED` | Required source evidence is missing, incomplete, stale, ambiguous or cannot be independently verified. |

No HTTP status, retryability flag or wire enum is frozen here. W8 must map the producer code unchanged inside its reviewed envelope only after DTO/version ratification. `UNKNOWN` and `UNRESOLVED` remain domain outcomes, not error-code aliases. An ambiguous mutation must not be turned into a safe automatic retry; Gateway's transport-level unknown outcome remains W8-owned.

## 7. WS8 crosswalk and audience binding

WS8 accepted the V9 transport crosswalk with blockers. WS2 confirms:

- `producer_id` derives from authenticated Control host/service identity, never caller JSON.
- Intended audience derives from authenticated route/host configuration. The receiver independently compares authenticated peer/service identity and configured audience with its own identity before accepting.
- Outer envelope major/minor version stays distinct from each inner W2 DTO version.
- Transport message ID is distinct from command/request/event/claim/renewal/receipt/idempotency identities.
- Plan/command/ACL/event/journal/claim-authenticator/outer payload digests remain separate domains.
- `stream_id=workflow_id`; committed `event_seq` and predecessor event ID are outputs. `expected_prior_sequence` and `expected_prior_head_sha256` are pre-commit CAS inputs. A stale/fork CAS rejects before append. Incomplete history has no fabricated ordering and remains UNKNOWN/UNRESOLVED.

WS8's review is transport-crosswalk acceptance only. Common Envelope remains DRAFT; no Control route, remote peer authentication, per-service identity/audience configuration, durable remote idempotency/reconciliation endpoint or Gateway dispatch is approved or proven.

## 8. Outstanding review/acceptance gates

| Gate | Status |
|---|---|
| WS1 CompiledPlan mapping | REVIEW_ACCEPTED for task/plan mapping only; runtime attachment, append-only lifecycle event and policy attachment remain NOT PROVEN. |
| WS3 Claim V4 / ExecutionFence V2 | FEASIBLE_WITH_VERSIONED_IMPLEMENTATION; exact canonical vectors and owner approval required. |
| WS3 Lease renewal | DRAFT; exact durable request/receipt replay vectors and WS3 WorkerStore ownership/migration decision required. |
| WS3 ProcessStop attestation | BLOCKED; local receipt remains unsigned/local-only. |
| WS6 Governance receipt | REVIEW_ACCEPTED_WITH_BLOCKERS; production signer/domain, durable nonce owner, Control projection and revocation-to-commit fence blocked. |
| WS7 evidence/recovery | No reciprocal WS7-to-WS2 ACL edge; direct review response cannot be received under current ACL. Escalate to Project Owner and both endpoint owners; do not alter ACL locally. |
| WS8 common envelope | ACCEPTED_WITH_BLOCKERS for transport crosswalk only; common-envelope schema, route/auth and integration not ratified. |
| Stable error vocabulary | DRAFT; proposed new codes require exact fixtures and consumer review. |
| Cancellation/recovery disposition/retry takeover/D-01 | BLOCKED by master-plan Project Owner and authority decisions. |

No contract is RATIFIED by this addendum. No source, schema, Store, manifest, route, WorkerStore, deployment, migration, signer or ACL change is authorized. The accepted architecture remains exactly three deployables with eight workstreams inside those boundaries.
