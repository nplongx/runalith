# Worker Control API contract v1

This document defines the HTTPS contract consumed by `runalith-worker::HttpControlPlane`. All routes are relative to `RUNALITH_CONTROL_URL`, require TLS, and use `Authorization: Bearer <worker-token>`. The worker does not follow redirects. JSON request and response bodies are limited to 2 MiB.

**Implementation boundary:** `runalith-control-api` now contains authenticated HTTP route adapters for worker claim receive/verification, lease renewal, result/provider-result publication, session delivery, and execution-fence reservation/completion. These adapters require a host-injected `WorkerControlAuthority`; `ControlApi::from_store` intentionally leaves that authority unset, and the standalone `runalith-control` binary does not inject it. Consequently `/v1/worker/*` returns `503` in the current standalone composition and no worker event, lease, ACL decision, or side effect is acknowledged. The host-owned authority must serialize lease/owner-epoch changes, ACL revalidation, durable idempotency receipts and fence transitions in its authoritative database transaction. The worker supervisor calls the typed reservation/completion client methods before sandbox start/provider dispatch and fails closed when a reservation or completion receipt is absent, rejected, ambiguous, or mismatched. Route-adapter tests prove authentication, capability and payload/path binding only; they do not establish the missing authority implementation, server-side fencing, or cross-process integration.

## Claim schema v3

`POST /v1/worker/claims/receive`

Request:

```json
{"worker_id":"worker-01"}
```

Return `204 No Content` when no claim is available, or `200 OK` with `{"claim": <TaskClaimEnvelope>}`. The claim uses `schema_version: 3` and binds at least:

- `claim_id`, `idempotency_key`, workflow/task/attempt, worker ID, lease ID, owner epoch, expiry;
- immutable `plan_sha256` and exact `command_sha256` plus the sandbox command;
- a Control authenticator covering the complete serialized claim and including `acl_sha256`, a lowercase SHA-256 digest of the authorization decision inputs used for execution-fence reservation;
- optional `provider_dispatch` containing provider ID, stable idempotency key, workflow/task/attempt, lease/worker, plan digest, request digest, and exact JSON payload;
- `session_messages`, each bound to workflow/task/attempt, worker, lease, owner epoch, session, recipient role, message type, expiry, and payload.

The authenticator must cover the complete serialized claim, including provider and session fields and the `acl_sha256` value. `acl_sha256` binds the principal, resource, action, relevant session membership/recipient role and policy version; Control must still re-evaluate current ACL state transactionally when it reserves or commits a side effect. The worker rejects a missing or malformed `acl_sha256`, provider payload digest mismatches, identity mismatches, expired session messages, duplicate message identities, oversized payloads, and messages whose owner epoch differs from the claim.

`POST /v1/worker/claims/verify`

Request: `{"claim": <TaskClaimEnvelope>}`. Return `200` with `{"valid":true}` only when the signature/authenticator is valid, the worker identity matches the bearer credential, the claim is unexpired, the exact immutable plan and command digests are authorized, and the claim still has authority to start. Return `401`/`403` for failed authentication or authorization. A valid signature alone is insufficient if ownership has since changed. Schema v2 claims are rejected by this worker because they do not carry the mandatory signed `acl_sha256` authorization binding; deploy the matching Control claim issuer before upgrading the worker.

`POST /v1/worker/leases/renew`

Request: `{"renewal_id":"lrn_<unique-id>","claim": <TaskClaimEnvelope>, "lease_seconds": 120}`. `renewal_id` is generated once per HTTP call and must be reused byte-for-byte for any retry of that same call. Control stores it as an idempotency identity in the authoritative transaction; a duplicate exact request returns the original expiry and does not extend the lease again. Each new heartbeat uses a fresh ID. Return `200` with `lease_id`, `owner_epoch`, `worker_id`, and RFC3339 `expires_at`. Renewal must atomically verify that the exact lease, worker, attempt and owner epoch are still current and unexpired before creating or replaying a renewal receipt. A new owner epoch invalidates the old worker immediately. Return `401`/`403`/`409` when renewal is rejected.

## Result inboxes

`POST /v1/worker/results` accepts a `WorkerResultEvent`. `POST /v1/worker/provider-results` accepts a `ProviderResultEvent`.

Both endpoints must transactionally validate the active lease, worker identity, owner epoch, immutable plan digest, command/provider request digest, and event identity before accepting the event. Enforce unique event IDs and idempotency keys. Compute `event_sha256` as the Runalith canonical content hash of the exact submitted JSON event. First acceptance returns `200`/`201`; exact duplicate returns `208` or `409 {"code":"ALREADY_ACCEPTED"}`. All accepted/duplicate responses must include `event_id`, matching `event_sha256`, and an object-valued durable `receipt`. A stale lease/epoch returns `409 {"code":"STALE_OWNER","event_id":"...","event_sha256":"...","receipt":{...}}` with a durable rejection receipt bound to the rejected event; the worker never acknowledges this outbox event without that receipt. Reuse of an event ID with a different digest is a conflict and must never be treated as accepted.

The worker acknowledges accepted, exact duplicate, and explicit `STALE_OWNER` results. Definitive `400`, `404`, `410`, `422`, and unrecognized `409` responses are durably quarantined as `REJECTED`; they are never acknowledged as accepted or automatically retried. `401`/`403` remain visible authorization failures and do not discard the local outbox event. Ambiguous transport/5xx outcomes retain the same event ID and may retry result publication because the endpoint is required to be idempotent.

## Session delivery

`POST /v1/worker/sessions/deliver` accepts one `SessionDeliveryEnvelope`.

Immediately before committing the session message, Control must atomically revalidate current owner epoch, lease ID, worker ID, workflow/task/attempt binding, session membership, recipient role, ACL, message expiry, and idempotency key. This check must happen at the delivery boundary, not only when the task claim was issued. A stale worker must never write into a session after ownership or ACL changes.

On success return `200`, `201`, or `208` with this binding shape (receipt content is service-defined):

```json
{
  "message_id":"message-01",
  "session_id":"session-01",
  "lease_id":"lease-01",
  "owner_epoch":7,
  "receipt":{"delivery_id":"delivery-01"}
}
```

The worker accepts success only when every binding exactly matches the submitted message and `receipt` is an object. An exact duplicate must return the original receipt. Return `409 {"code":"STALE_OWNER"}`, `STALE_SESSION`, or `ACL_REVOKED` only when the message is permanently rejected by current ownership/session authorization. Session HTTP `422` is treated as `UNKNOWN`, not `NOT_SENT`; all ambiguous delivery outcomes are quarantined and never automatically replayed.

## Provider dispatch and reconciliation

The provider dispatch request is carried inside the authenticated claim. The worker persists a `RESERVED` provider intent before invoking the configured adapter. Provider adapters must perform their own exact idempotency lookup and never replay an ambiguous send. Accepted, rejected, and unknown dispatch responses are persisted before local execution continues or stops.

Control receives terminal provider events through `/v1/worker/provider-results` and must fence them against the same current lease and owner epoch. Provider result artifacts are content-addressed by the worker before publication.

## Transport behavior

- HTTPS only; normal certificate and hostname verification must remain enabled.
- Do not redirect worker API routes. The client does not enable curl redirect following.
- Responses must be valid JSON for successful JSON endpoints and stay within 2 MiB.
- `200`/`201`/`208` success responses must be committed before the response is written.
- `409` must include a recognized machine-readable code; a generic conflict is ambiguous.
- Session `422` is currently not treated as proof of `NOT_SENT`; only a future explicit non-HTTP transport proof could justify that classification.
- The worker uses stable IDs and retries only idempotent result publication. It never retries provider dispatch after `UNKNOWN` or session delivery after an ambiguous transport start. Definitively rejected result events enter durable `REJECTED` quarantine and require operator or Control-side remediation.

## Atomic side-effect ownership fencing — required server extension

**The route adapter exists; its authoritative Control backend does not yet exist in the current composition.** `WorkerSupervisor` requests a `sandbox_start` reservation after lease renewal and before invoking the sandbox; it binds the request digest to the exact command and the sandbox's effective policy/resource-profile digest. It also requests a `provider_dispatch` reservation before invoking a provider adapter and persists the exact reservation in worker SQLite schema v5, bound to the running inbox claim, owner epoch, lease, plan and complete dispatch-request digest. A provider `Accepted` response is deliberately completed as `UNKNOWN`, not `SUCCEEDED`, because it proves creation of a remote run but not terminal completion; this retains the owner fence. `ProviderPoller` now completes that same persisted fence only after exact provider run lookup, terminal conclusion validation and content-addressed artifact collection. A missing/ambiguous completion receipt leaves the provider intent non-terminal and retries the same deterministic terminal event ID/digest; it never re-dispatches. The v4→v5 migration adds nullable reservation persistence and preserves old intents without granting them a fence. Missing/invalid sandbox profile digests, reservation rejection, and ambiguous or invalid completion receipts stop further execution; provider ambiguity is retained as `UNKNOWN`. Worker-side fake-Control tests and route-adapter tests verify denial paths, request binding and exact receipt handling, but no configured `WorkerControlAuthority` currently executes the authoritative lease/ACL/fence transaction. They therefore do not verify ownership-transfer races, server restart recovery, or real HTTP integration. The backend must support an idempotent `UNKNOWN`→terminal transition for the same reservation and return the same receipt for an exact repeated terminal event. Result publication and session delivery must revalidate current lease/session ACL in that same authoritative persistence boundary before they can be enabled.

**Store v20 execution-fence persistence behavior:** `Store::complete_worker_execution_fence` now returns a per-observation result and uses the append-only workflow event journal as its observation ledger. The idempotency identity is `worker.execution_fence.observation:<fence_id>:<event_id>`. An exact replay returns that observation's original receipt, including after a later terminal observation; reuse of the same event ID with changed completion content conflicts. `UNKNOWN` and unverified `NOT_STARTED` observations append durable events but leave the fence `RESERVED`. `SUCCEEDED` and `FAILED` require `WorkerExecutionFenceCompletionVerifier` and transition the fence projection to `COMPLETED` only after the verifier succeeds inside the same `BEGIN IMMEDIATE` transaction. A proof-verified `NOT_STARTED` may also complete; the unverified method records it without release. A caller-provided digest alone is not accepted as terminal proof. This fixes the Store primitive's former behavior of finalizing every outcome, but it does **not** constitute a configured production verifier or `WorkerControlAuthority`: the HTTP routes still fail closed with `503`, and transaction-time ACL, authenticated principal-to-claim binding, claim signing, owner-transfer integration and process/cgroup settlement still require the authoritative Control composition and its owner-approved contracts.

Before starting sandbox execution or invoking a provider adapter, the worker must obtain a durable side-effect reservation bound to:

- authenticated worker identity and bearer credential;
- claim, workflow, task, attempt, lease ID and current `owner_epoch`;
- immutable execution-plan digest;
- side-effect kind and exact request/command digest;
- a unique reservation ID and idempotency key.

The proposed v1 extension is:

`POST /v1/worker/execution-fences`

```json
{
  "claim_id": "claim-123",
  "lease_id": "lease-456",
  "worker_id": "worker-01",
  "owner_epoch": 17,
  "plan_sha256": "<64 lowercase hex>",
  "side_effect_id": "provider-dispatch-1",
  "kind": "provider_dispatch",
  "request_sha256": "<64 lowercase hex>",
  "idempotency_key": "<stable claim-scoped key>",
  "acl_sha256": "<digest of the authorization binding checked by Control>"
}
```

`kind` is exactly one of `sandbox_start`, `provider_dispatch`, `result_publish`, or `session_delivery`. `request_sha256` is the canonical digest of the complete immutable side-effect request, not a digest of selected fields. For `sandbox_start` it binds the exact command digest and sandbox policy/resource profile. For `provider_dispatch` it binds provider ID, idempotency key and exact provider payload digest. For `result_publish` it binds exact event ID and event digest. For `session_delivery` it binds message ID, session, recipient role, payload digest and delivery idempotency key. `acl_sha256` binds the exact authorization decision inputs (principal, resource, action, session membership/recipient role where applicable, and policy version); it is not a substitute for re-evaluating current ACL state inside the transaction.

Return `201` with `{ "fence_id", "claim_id", "lease_id", "worker_id", "owner_epoch", "plan_sha256", "side_effect_id", "kind", "request_sha256", "idempotency_key", "state":"RESERVED", "receipt":{} }`. Repeated identical requests return the same fence and receipt. Reuse of the idempotency key with a different claim, epoch, kind, side-effect ID, plan digest, ACL binding or request digest is a permanent conflict. Stale owner, expired lease, changed plan or revoked ACL returns a machine-readable `409 STALE_OWNER`/`ACL_REVOKED` bound to the exact request and accompanied by a durable rejection receipt. Missing or mismatched receipt is ambiguous to the worker and must not be acknowledged.

The reservation transaction must lock/serialize on the authoritative task/lease row before validating it, then validate authenticated bearer-to-worker binding, claim identity, active lease, current owner epoch, attempt, immutable plan digest, request digest, current ACL and session membership as appropriate. Insert the reservation under a unique `(claim_id, owner_epoch, kind, side_effect_id)` constraint and a unique idempotency key. The lease/owner-transfer transaction must acquire the same serialization lock and reject transfer while any reservation for that owner epoch is `RESERVED` or `UNKNOWN`. A TTL is diagnostic only; it must never release an uncertain side effect. Use a serializable transaction or equivalent row-lock/CAS protocol whose isolation semantics are demonstrated by server integration tests; a sequence of independent reads followed by an insert is not sufficient.

`POST /v1/worker/execution-fences/{fence_id}/complete`

```json
{
  "claim_id": "claim-123",
  "lease_id": "lease-456",
  "worker_id": "worker-01",
  "owner_epoch": 17,
  "plan_sha256": "<same plan digest>",
  "side_effect_id": "provider-dispatch-1",
  "request_sha256": "<same request digest>",
  "outcome": "SUCCEEDED",
  "event_id": "<stable result event id>",
  "event_sha256": "<canonical Runalith content hash>",
  "outcome_sha256": "<digest of exact provider/process outcome>"
}
```

Return `200`/`208` only with exact `fence_id`, claim/lease/worker/epoch/plan/side-effect/request bindings, event ID, event digest and object-valued durable receipt. Completion request also includes `fence_id` and `outcome`; `outcome` is exactly `SUCCEEDED`, `FAILED`, `UNKNOWN`, or `NOT_STARTED`. `outcome_sha256` binds the exact terminal observation/evidence bytes. `UNKNOWN` has no release semantics. For provider dispatch, the first completion may append an `UNKNOWN` dispatch observation while retaining the active reservation; a later terminal reconciliation may transition that same reservation from `UNKNOWN` to `SUCCEEDED`/`FAILED`/`NOT_STARTED` with a distinct stable terminal event ID and exact terminal evidence. Persist every completion observation append-only. Exact retries of a given `(fence_id,event_id,event_sha256,outcome_sha256)` return the same receipt; reuse of an event ID with a different digest is a conflict; a second, conflicting terminal completion for the same fence is rejected. No other transition out of `UNKNOWN` is automatic. `NOT_STARTED` is legal only with independently verifiable proof that the side effect did not begin; a local cancellation check or failed renewal after reservation is not proof. For `sandbox_start`, Control must not release the reservation until the worker reports that the process group/cgroup is empty and terminal evidence is durably stored. For provider dispatch, Control must retain the reservation through provider idempotency lookup and reconciliation. For session delivery, the durable delivery receipt is the completion receipt and ACL must be checked in the transaction that inserts the message.

In one database transaction, validate the authenticated worker, lease/owner binding, immutable plan digest, ACL, fence state and event identity; persist the append-only completion observation/receipt; transition the fence. `UNKNOWN` is durable and keeps ownership fenced until reconciliation; it is never auto-released by timeout. The provider-specific `UNKNOWN`→terminal transition must prove the exact already-bound provider run identity and immutable dispatch intent; it must not issue another dispatch. A definitive `SUCCEEDED` or `FAILED` may release the fence only in the same transaction that commits its exact result receipt and proves the side effect terminal. `NOT_STARTED` may release only with explicit proof recorded in the receipt. A provider dispatch can still be reconciled after the worker's local task result has terminalized: in that narrow case the persisted attempt and `owner_epoch` must still identify the exact historical owner, the completion is limited to the existing `provider_dispatch` reservation, and it cannot rewrite the task result or create a new lease. Sandbox-start completion remains a prerequisite to publishing the local task result. The server must serialize owner transfer against reservation and completion (for example, `BEGIN IMMEDIATE`/serializable row locking plus a unique active-fence constraint).

Control must create the reservation in the same transaction that validates the active lease and ACL. While a reservation is active, Control must not transfer ownership, advance `owner_epoch`, issue a competing claim, or accept a conflicting side effect for that execution. Reservation state must survive worker and server restarts. It must not be released merely because a TTL elapsed: an interrupted provider reservation must first be reconciled by exact provider idempotency lookup; an interrupted sandbox reservation must be reconciled against process/cgroup identity and durable evidence; an interrupted session delivery must be reconciled by message ID and delivery receipt. If the provider cannot prove whether dispatch occurred, the reservation remains `UNKNOWN` and blocks ownership transfer until operator resolution.

The worker reports the terminal side-effect outcome using the reservation ID and exact outcome digest. Control atomically validates the reservation/owner epoch, persists the terminal event and durable receipt, and releases the reservation in the same transaction. Result publication and session delivery must independently revalidate current lease, owner epoch, session membership, recipient role and ACL in the transaction that writes the result/message. A stale worker must not be able to publish a result, provider observation, artifact reference, or session message after ownership transfer.

For provider dispatch, Control must preserve the reservation across the complete external call and any ambiguous reconciliation window. A client-side renewal, a short-lived signed token, or a second local cancellation check is not an equivalent fence. Server integration tests must race lease transfer against reservation creation, provider dispatch, sandbox process start, process completion, result receipt, artifact publication and session delivery, including server restart and worker crash at each boundary. Tests must prove exactly one of: reservation wins and ownership transfer waits; or ownership transfer wins and stale reservation is rejected before the side effect. There must be no interleaving in which both a new owner and stale worker perform externally visible effects.

## Sandbox resource containment

The standalone worker requires Linux cgroup v2 delegation for `cpu`, `memory`, and `pids`. The systemd unit sets `Delegate=cpu memory pids` and `DelegateSubgroup=runalith-manager`; systemd must place the worker process in that subgroup so the delegated parent is empty and satisfies cgroup v2's no-internal-process rule. `ProtectControlGroups` must remain disabled for this delegated service cgroup. The worker enables available controllers on the empty delegated parent, creates one child cgroup per execution, applies `cpu.max`, `memory.max`, `memory.swap.max=0`, and `pids.max`, then moves the trusted launcher into that cgroup before it execs Bubblewrap. `cgroup.kill` is required for cleanup. Missing controllers, missing kernel interfaces, unwritable delegation, non-empty delegated parent, or cleanup failure are fatal; there is no rlimit or unsandboxed fallback.

Defaults are 1 GiB memory, one CPU, 64 tasks and 128 MiB each for `/tmp` and `/runalith-scratch`. Operators may override these with `RUNALITH_SANDBOX_MEMORY_MAX_BYTES`, `RUNALITH_SANDBOX_CPU_QUOTA_MICROS`, `RUNALITH_SANDBOX_CPU_PERIOD_MICROS`, `RUNALITH_SANDBOX_PIDS_MAX`, and `RUNALITH_SANDBOX_SCRATCH_MAX_BYTES`. `RUNALITH_WORKER_CGROUP_ROOT` optionally selects an explicit delegated cgroup root; otherwise the worker resolves its current cgroup from `/proc/self/cgroup`.

**Per-execution project quota implementation / host acceptance blocker:** the worker now allocates a monotonic project ID per RUNNING claim, persists an `ALLOCATING` intent before directory creation, assigns the project ID with inherited-project flag, sets byte and inode hard limits, and reads both hard limits back before marking the exact device/inode `ACTIVE` and allowing sandbox start. The worker uses `runalith-linux-quota` through a root-owned systemd socket helper; only that helper receives `CAP_SYS_ADMIN` and `CAP_FOWNER`, while the worker remains capability-free. The helper binds the request to the worker UID (`SO_PEERCRED`), an exact project-ID path slot, the device/inode in a root-owned append-only registry, a configured filesystem root, and root-owned immutable maximum byte/inode values. On terminal success/failure, the worker verifies the recorded directory identity, removes it, reads kernel usage back as zero, clears the quota, and only then records `RELEASED`. UNKNOWN, restart, or cleanup ambiguity produces `QUARANTINED`; project IDs are append-only and never reused. **The current development host's ext4 mount does not have `prjquota`, so live kernel byte/inode exhaustion and project charge cleanup could not be exercised here.** The production worker now correctly fails startup when the helper or active project-quota mount is unavailable. Do not admit untrusted workloads on a host until `findmnt -T "$RUNALITH_WORKER_WORKSPACE_ROOT"` confirms `prjquota`/`pquota`, helper readback succeeds, and the deployment's kernel-level byte/inode exhaustion and cleanup tests pass. cgroup `io.max` and tmpfs limits are not substitutes.

The workspace bind source is opened by the trusted launcher, checked against the device/inode identity captured at sandbox construction, and passed to Bubblewrap using `--bind-fd`. The launcher first joins the execution cgroup; it does not start Bubblewrap or task code if the workspace path was replaced.

The production JavaScript workspace-write service stores intents in `workspace_write_intents` in the workflow SQLite database. It commits the intent in a separate transaction before filesystem mutation; the later receipt/event transaction deletes the intent atomically with receipt persistence. Each intent records PID, process start ticks and boot ID. Recovery refuses to touch an intent owned by a still-live process, preventing a concurrent request from mistaking an in-flight write for a crashed writer. After process death, recovery persists a receipt only if exact after-hash is present, discards the intent only if exact before-hash remains, and fails closed on any third state. The Rust `WorkspaceWriteCapability` also uses a private journal under artifact storage. These are recovery protocols across filesystem and database boundaries, not cross-filesystem atomic transactions.

The Linux filesystem capability stages replacement bytes at the pinned workspace-root descriptor and resolves the target with `openat2` using `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`. Publication now uses `renameat(root_fd, temp_name, pinned_parent_fd, basename)`: it does not re-resolve the multi-component destination path, so a symlink substituted after the final parent check cannot redirect the staged file to the symlink target. After publication, the code syncs the pinned parent and reopens the requested parent from the capability root; if its device/inode identity changed, it returns `MutationUncertain` and leaves the durable write intent for fail-closed recovery instead of issuing a receipt. `post_resolution_symlink_substitution_cannot_redirect_descriptor_anchored_publish` exercises the exact post-resolution interval: the requested parent becomes a symlink to an outside directory, the file is not written there, and the operation remains unresolved with its intent retained. The pre-resolution relocation/symlink tests and eight-writer base-hash race also remain.

**Residual filesystem acceptance boundary:** descriptor-anchored `renameat` prevents an intermediate replacement symlink from redirecting the final rename, but a directory FD continues to reference its inode if a host actor moves that directory. A privileged or same-UID host process able to move the pinned parent inode outside the workspace root after validation could therefore cause publication into that moved directory before the post-publication identity check reports `MutationUncertain`. The worker service account must remain dedicated/non-shared, and Bubblewrap tasks must receive only the workspace bind mount, never the host parent or host `/tmp`; the sandbox mount namespace must prevent task code from moving the workspace root or its pinned parent outside that mount. Root-equivalent and other host processes with the worker UID remain trusted actors, not adversaries covered by the current implementation. If hostile same-UID host processes are in scope, acceptance still requires a kernel-enforced publication boundary or an immutable mount/parent layout that prevents moving the pinned directory inode; the post-check alone is not that guarantee. Do not describe this residual host-actor threat model as closed.

The workspace-write journal serializes its own mutations and recovery, including across processes, but does not serialize arbitrary external writers that bypass the capability. Compare-hash followed by rename is not a transaction against such writers. The sandbox must therefore remain the only untrusted writer and the service account must not be shared; if arbitrary concurrent writers are in scope, the write API needs an additional kernel-enforced per-target serialization boundary. Never describe the current journal as a filesystem-wide transaction.

