# WS2 Control contract candidate — V10.1 addendum

**Status:** DRAFT / PROPOSED / NOT RATIFIED.  
**Base:** V9 candidate SHA-256 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5` plus V10 addendum SHA-256 `9fb54a38f1f97f41af6d969d6ec06fc8a779beddcf9128ce0049ffb74375b9e8`.  
**Purpose:** capture exact follow-up clarifications from WS3, WS6 and WS8 after the immutable V10 review. Neither V9 nor V10 file is modified.

## 1. ExecutionFenceV2 subject continuity — WS3 clarification

WS3 confirms that the identical authenticated `attempt` and immutable subject must be carried through the entire fence lifecycle:

1. reservation request;
2. reservation response;
3. completion request;
4. durable completion receipt.

The completion receipt binds the same `fence_id`, `claim_id`, `attempt`, `lease_id`, `worker_id`, `owner_epoch`, plan digest, request digest, event identity and exact durable outcome receipt. Completion must not detach from or rebind another attempt. WS2 accepted this as a DRAFT producer/consumer requirement in reply `090de727-dab7-45a6-a4fa-62578d62166e` to WS3 review message `99ca2a4e-f81f-4a56-bafe-d73a3a0e719e`.

WS3 owns its `ExecutionFenceV2` consumer DTO/proposal and WorkerStore journal compatibility. WS2 owns Control's issuer/producer DTO and authoritative completion CAS. Exact reservation/response/completion/receipt vectors, V1 journal compatibility and named accountable owners remain required. WS3's latest V2 proposal SHA-256 reported in seq 481 is `efa04fd1440565e221a8b41e39736d7e44f50370c038e4e9f98adfeaddf8fb3c`; this is WS3-owned and has not been integrated into WS2's worktree.

## 2. WS3 observation mapping successor hash

WS3 issued an additive mapping successor with SHA-256 `27845d70edbacd6f279cb1e3e4e3e214afb1bacee8218d0915061e50cae3694a`. Example SHA-256 remains `601f0e9787709e60f145b69cf717549668f93edec4a768c273c483ce05b01d7e`; validator SHA-256 remains `7524842367ba7c7e16db5123f4ee454555c056f71560206781f90ed244527e38`.

WS2 accepted that exact mapping digest with blockers: outer W8 `payload_digest`, W3 semantic message identity, W2 TaskResult `event_id`/event digest/idempotency remain distinct. Control inbox receipt proves durable receipt only; it does not verify nested manifest/evidence. Evidence verification remains a separately authorized source-owner fact. The exact WS2 reply is `086dd3fe-9a53-41a5-8fbc-bfdc841fb529`, replying to WS3 message `dc402b4c-4b95-42e1-aeff-a1c741d8fbf5`.

## 3. WS6 Governance projection precision and error diagnostics

WS6 accepted V10 with blockers and supplied these additional exact projection fields. The immutable Control projection/reference must preserve:

- originating `request_id` and idempotency scope;
- `decision_id`, receipt schema version/kind;
- exact `receipt_sha256`, `signed_envelope_sha256` and `receipt_payload_sha256`;
- all `ApprovalSubjectV1` fields: workflow, candidate, candidate digest, plan digest, source snapshot digest and action scope;
- evidence digest, Approved/Rejected decision, policy ID/version/digest, and reviewer subject list/digest when present in the ratified receipt;
- authenticated issuer, provider ID, audience, trust domain, scope, algorithm, key ID, trust-root digest, `TrustSnapshotRef` identity/digest, configuration fingerprint/version, nonce and issue/expiry timestamps;
- Control-owned local logical DB identity, generation/restore epoch, monotonic projection sequence/high-water and inbox/outbox event identities.

Retain exact signed receipt bytes or an immutable retrievable reference for audit/revalidation. Do not persist Governance private keys, trust-root PEMs, mutable Governance policy tables or Governance nonce rows as Control truth. Control alone creates its local DB identity/generation/restore epoch/projection sequence; never copy these from Governance.

WS6 also clarified error boundaries. Keep verifier diagnostics distinct:

- invalid signature or issuer proof is not trust unavailable;
- exact subject/audience mismatch is not stale/revoked/expired trust;
- nonce rebinding is an idempotency/replay conflict;
- `AUTHORITY_UNAVAILABLE` covers missing/unavailable authority or trust high-water but must not erase more specific verifier causes or become a generic retryable outcome;
- valid `Rejected` is a signed domain decision and never authorizes admission.

The exact public diagnostic subcodes and fixtures remain DRAFT. WS2 acknowledged this in reply `3c2d46e7-eb34-420a-8598-fbe3c9e57fd9` to WS6 message `803ac906-c589-4ea3-9108-0c98a19808c9`.

Nonce semantics remain WS6-owned. Durable nonce persistence owner and atomic boundary are UNASSIGNED. Governance-side nonce consume and Control-side projection are not cross-database atomic. Observer high-water is not transaction-bound to later Control commit; a Project Owner-approved freshness/revocation fence remains required. No network call inside the Control SQLite transaction or direct Governance DB access.

## 4. WS8 transport representation disposition

WS8 accepted the V10 transport representation with blockers in message `6ee386bb-0107-472c-b231-bc56abb7fe63`. WS2 acknowledged in reply `8e6eb95c-5f13-48e1-a6db-4d35321b9c62`.

- W2 owns exact domain-code strings and meaning. W8 preserves `domain_code` unchanged; its transport category is supplemental.
- `ILLEGAL_ACTIVE`, `TERMINAL_REOPEN`, `INVALID_PHASE_TRANSITION` retain exact Node-oracle spelling/meaning.
- `MALFORMED_REQUEST` may be accompanied by transport category `REQUEST_INVALID`; preserve the producer code.
- Inner `UNSUPPORTED_SCHEMA_VERSION` is distinct from outer envelope `SCHEMA_UNSUPPORTED`.
- `IDEMPOTENCY_CONFLICT` may use the transport conflict category only; no other codes are automatically aliased.
- `SUBJECT_MISMATCH`, `STALE_OWNER`, `STALE_WORKFLOW_HEAD`, `ORDERING_GAP`, `AUTHORITY_UNAVAILABLE` and `EVIDENCE_UNRESOLVED` remain exact producer codes. Do not flatten them into auth failures, false, terminal failure or retryable `NOT_SENT`.
- Incomplete history/ordering gaps and unresolved evidence stay `UNKNOWN`/`UNRESOLVED`; mutations are not automatically retried.

This is transport representation acceptance only. New W2 codes remain DRAFT; no complete golden request/response/event vectors, HTTP status/retry mapping, public Control route, production auth/audience config, remote idempotency/reconciliation or Gateway dispatch are approved.

## 5. Outstanding authority relay

WS3's questions about a distinct ControlFenceReceipt verifier and WorkerProcessStopAttestation authority were relayed by WS2 to WS6 in A2A message `578b2fcf-491c-4722-b4a8-686675881fa2`. WS2 confirmed the relay to WS3 in `212ded8b-ffb6-41c2-a0a2-432d6849aafe`. WS6 decision remains pending. Do not reuse GovernanceApprovalReceipt implicitly, invent a sixth trust domain, or sign/settle from a local ProcessStop observation.

## 6. Status

- WS3 claim/fence/renewal and completion subject: ACCEPTED_WITH_CLARIFICATIONS / NOT RATIFIED.
- WS3 observation mapping hash `27845d…`: REVIEW_ACCEPTED_WITH_BLOCKERS / NOT RATIFIED.
- WS6 Governance receipt consumer: REVIEW_ACCEPTED_WITH_BLOCKERS / NOT RATIFIED.
- WS8 transport crosswalk/error representation: ACCEPTED_WITH_BLOCKERS / NOT RATIFIED.
- WS7 reciprocal review: BLOCKED by missing WS7→WS2 ACL edge. No ACL change.
- WS2 stable new error codes and all remaining canonical DTO vectors: DRAFT.
- Production signer/verifier, WorkerStore migration, Control projection persistence, cancellation settlement, terminal recovery disposition, same-task cross-deployable retry, D-01 and deployment: BLOCKED.

No source, schema, WorkerStore, database, manifest, route, credential, deployment, ACL or migration changes are authorized by this addendum. Three deployables remain unchanged.
