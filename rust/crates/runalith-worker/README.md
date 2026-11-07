# Runalith execution worker

`runalith-worker` is a standalone Linux process. It receives authenticated, immutable task claims from the Control HTTPS API, verifies claim bindings, executes commands through Bubblewrap, stores evidence by content digest, and publishes results through a durable SQLite outbox. It also dispatches explicitly authorized provider requests, reconciles provider runs, collects terminal evidence, and delivers claim-bound session messages.

The worker has no `runalith-store` dependency. Its private SQLite database is local durable execution state, not a shared application database.

## Runtime requirements

- Linux with unprivileged user namespaces enabled for the service account.
- Bubblewrap (`bwrap`) and curl installed at configured absolute paths.
- A dedicated ext4/XFS workspace mount with active `prjquota`/`pquota`; each claim gets a separate project-ID workspace with kernel byte and inode hard limits. The worker contacts a root-owned quota helper through a peer-credential-checked Unix socket and does not receive `CAP_SYS_ADMIN`.
- A durable worker state directory on a local filesystem supporting SQLite WAL and file locking. Do not put the database on NFS or an object-store mount.
- A reachable HTTPS Control API implementing [`worker-control-api-v1.md`](../../docs/worker-control-api-v1.md).
- A Control-issued bearer token scoped to one registered worker identity.

The repository contains both the worker client/protocol and HTTP route adapters for `/v1/worker/*`. The route adapters require an injected `WorkerControlAuthority` that owns the durable lease, owner-epoch, session-ACL, result and execution-fence transactions. The standalone Control binary does not configure that authority, so these routes deliberately return 503 and the matching Control service remains an external deployment prerequisite; the worker alone cannot provide end-to-end execution until that server-side implementation is connected.

## Configuration

Copy [`worker.env.example`](../../deploy/worker/worker.env.example) to `/etc/runalith/worker.env`, replace placeholders, and set file mode `0600`. Required variables:

| Variable | Meaning |
| --- | --- |
| `RUNALITH_WORKER_ID` | Stable identity registered in Control. |
| `RUNALITH_WORKER_DATA_DIR` | Absolute private state directory; default deployment uses `/var/lib/runalith-worker`. |
| `RUNALITH_CONTROL_URL` | HTTPS Control API origin, without query or fragment. |
| `RUNALITH_CONTROL_TOKEN` | Worker-scoped bearer credential. |
| `RUNALITH_WORKER_WORKSPACE_ROOT` | Dedicated workspace root on an ext4/XFS project-quota mount. |
| `RUNALITH_WORKER_QUOTA_HELPER_SOCKET` | Root-owned quota broker socket; default `/run/runalith-quota/quota.sock`. |
| `RUNALITH_WORKER_WORKSPACE_QUOTA_BYTES` | Per-execution byte hard limit; default 2 GiB. |
| `RUNALITH_WORKER_WORKSPACE_QUOTA_INODES` | Per-execution inode hard limit; default 100,000. |

Optional variables:

| Variable | Default | Bounds / purpose |
| --- | --- | --- |
| `RUNALITH_WORKER_CURL_BINARY` | `/usr/bin/curl` | Absolute executable path. |
| `RUNALITH_WORKER_BWRAP_BINARY` | `/usr/bin/bwrap` | Absolute executable path. |
| `RUNALITH_WORKER_EXECUTABLE_ROOTS` | `/usr/bin,/bin,/usr/sbin,/sbin` | Comma-separated read-only executable roots. |
| `RUNALITH_WORKER_ALLOWED_ENV_KEYS` | empty | Explicit environment allowlist passed into the sandbox. |
| `RUNALITH_WORKER_TIMEOUT_SECONDS` | `600` | `1..=600` seconds. |
| `RUNALITH_WORKER_OUTPUT_LIMIT_BYTES` | `1048576` | `1..=1048576` bytes per output stream. |
| `RUNALITH_WORKER_LEASE_SECONDS` | `120` | `15..=600` seconds. |
| `RUNALITH_WORKER_POLL_INTERVAL_MS` | `1000` | `100..=60000` milliseconds. |
| `RUNALITH_WORKER_SHUTDOWN_FILE` | `<data-dir>/worker.stop` | Must remain inside the data directory. |
| `RUNALITH_WORKER_PID_FILE` | `<data-dir>/worker.pid` | Must remain inside the data directory. |
| `RUNALITH_WORKER_STOP_TIMEOUT_SECONDS` | `750` | `1..=900` seconds for the `stop` command. |
| `GITHUB_ACTIONS_TOKEN` | unset | Optional GitHub Actions provider credential. `GITHUB_TOKEN` is accepted as fallback. |

Provider credentials stay in the worker process and are never included in the sandbox environment allowlist by default. Do not add provider credentials to `RUNALITH_WORKER_ALLOWED_ENV_KEYS`.

Validate configuration before starting:

```sh
runalith-worker check-config
runalith-worker config       # prints a redacted configuration
runalith-worker --version
```

## Install and operate with systemd

**Execution admission remains blocked on a supported host filesystem and server-side Control integration.** The worker now allocates a unique monotonic project ID and workspace per claim, records its lifecycle in worker SQLite schema v7 (the append-only per-execution workspace ledger was introduced in v6), applies byte/inode hard limits through the root-owned quota helper, and reads both limits back before sandbox start. On UNKNOWN/restart/cleanup ambiguity, the workspace and project ID are quarantined and never reused. The current development host is ext4 without `prjquota`; the real kernel quota path cannot be exercised here, and the worker correctly fails closed during startup. The 128 MiB tmpfs limit still applies only to scratch mounts.

The service unit's cgroup delegation limits CPU, memory, and PIDs. Disk limits
are managed by the separate `runalith-quota-helper.service` with only
`CAP_SYS_ADMIN` and `CAP_FOWNER` and a Unix socket restricted to the worker UID.
Installing these units does not clear the current host's missing `prjquota`,
the residual workspace-write race window, or the missing authoritative
Workflow Control backend.

The independent CI workflow builds the worker and quota-helper binaries. Install `runalith-worker` as `/usr/local/bin/runalith-worker`, `runalith-quota-helper` as `/usr/local/libexec/runalith-quota-helper`, and install both service/socket units and their root-owned environment file.

Create the service account and workspace, then enable the unit:

```sh
sudo useradd --system --home-dir /var/lib/runalith-worker --shell /usr/sbin/nologin runalith-worker
sudo install -d -o runalith-worker -g runalith-worker -m 0700 /var/lib/runalith-worker
sudo install -d -o runalith-worker -g runalith-worker -m 0750 /srv/runalith/workspace
sudo install -d -o root -g runalith-worker -m 0750 /etc/runalith
sudo install -o root -g runalith-worker -m 0640 worker.env /etc/runalith/worker.env
sudo install -o root -g root -m 0600 quota-helper.env /etc/runalith/quota-helper.env
sudo systemctl daemon-reload
sudo systemctl enable --now runalith-quota-helper.socket
sudo systemctl enable --now runalith-worker.service
```

Set `RUNALITH_QUOTA_HELPER_WORKER_UID` in `quota-helper.env` to the numeric
output of `id -u runalith-worker`. The workspace root must be a dedicated
ext4/XFS filesystem mounted with `prjquota`/`pquota`; verify the active mount
options using `findmnt -T /srv/runalith/workspace`. The helper enforces root-
owned maximum byte/inode limits even if a worker requests larger values. Do
not grant `CAP_SYS_ADMIN` to the worker service.

The service unit runs `runalith-worker stop` as `ExecStop`; this creates the shutdown marker and waits for the active bounded claim and durable outbox drain to finish. Its stop timeout is longer than the maximum configured task timeout. The heartbeat stop channel is wakeable, so finishing a claim or dropping the guard interrupts an idle renewal wait rather than joining a thread that may be asleep for the full heartbeat interval. `KillMode=control-group` makes systemd terminate every process remaining in the worker unit, including descendant execution cgroups, if the bounded graceful stop expires. This is local process-tree cleanup; it is not a signed remote-provider terminality receipt and does not authorize Control lease settlement. For manual operation, `runalith-worker stop` uses the same environment variables and waits for the PID file to disappear.

## Observability

The process writes one-line JSON events to stderr/journald. Fields include timestamp, level, event name, worker ID, and sanitized details. Control and provider bearer values are redacted from loop diagnostics.

```sh
systemctl status runalith-worker.service
journalctl -u runalith-worker.service -f
runalith-worker health
runalith-worker metrics
```

`health` reports local SQLite availability and durable row counts. It is a local liveness check; it does not prove Control or provider connectivity. `metrics` emits Prometheus text-format gauges for durable row counts and can be captured by a node-exporter textfile collector. Provider polling logs include observed, bound, collected, and unresolved counts.

## Workstream 3 observation contracts

The W3 producer-owned semantic payloads live in `runalith_worker::observations`:

- `WorkerClaimAcceptedV1` can only be built from an in-process `VerifiedTaskClaim`. The current input implementation is `TaskClaimEnvelope` schema v3; it is not a ratified replacement for the shared W2 `TaskClaimV1` contract. Its opaque authenticator is not copied into the observation.
- `ProcessObservationV1` is derived from the content-addressed execution evidence manifest. The W3 manifest is schema v2 and preserves process/cancellation observations so they can be reconstructed after restart using the exact manifest digest and claim subject.
- `ProcessStopReceiptV1` is emitted by the producer only when the sandbox returned Linux cgroup-v2 evidence that the execution cgroup reached `populated 0`. Its scope is fixed to `local_worker_process_tree`. This proves local process-tree quiescence only; it does not prove a provider stopped, remote side effects are terminal, or a Control lease/cancellation may be settled.
- `WorkerHealthV1` reports the read-only local worker-store check and row counts only. It is not a host quota, Control, provider or end-to-end readiness signal.

The new runtime-only `WorkerExecutionEvidence` fields for cancellation-after-start and process identity are intentionally omitted from the existing W2 task-result JSON shape. They remain in the immutable W3 manifest; do not add them to the shared result envelope without W2/W8 contract approval. These semantic DTOs are producer-side types only: W8 still owns the shared wire envelope, producer authentication, registry and routing, so this change does not claim they are transport-enabled or cross-workstream ratified.

## Durability and recovery

- SQLite uses WAL, `synchronous=FULL`, foreign keys, a five-second busy timeout, transactional schema migrations, and a singleton process lock.
- The inbox uses unique claim, idempotency, and workflow/task/attempt keys. Claim acceptance and session-outbox insertion use immediate transactions; competing processes cannot both begin the same claim.
- A process lock records PID, Linux process start ticks, and a random owner token in SQLite. The token prevents an old process from releasing a newer lock. A dead process is detected using `/proc/<pid>/stat`, including PID reuse protection.
- The task result outbox is committed with the terminal inbox state before network publication. Retries reuse the same event ID and event digest.
- A `RUNNING` claim found after restart is quarantined as `UNKNOWN`. The worker never re-executes it automatically.
- Lease heartbeat shutdown is interruptible. A completed execution or dropped guard wakes the heartbeat thread immediately and joins it before result/fence settlement; it does not wait out the remaining lease-renewal sleep interval.
- Provider intent and the exact Control execution-fence request are committed locally before the Control reservation call; the fence request includes the stable claim-scoped idempotency key and ACL digest. If Control commits a reservation but its HTTP response is lost, recovery revalidates the immutable journal against the claim, ACL, exact dispatch payload digest and deterministic idempotency identity, retries that exact request and persists the original durable fence before provider lookup. A tampered journal stops before Control or provider transport. This retry is a reservation retry only: it never invokes provider dispatch. Only a newly reserved intent with a persisted authoritative fence is dispatched. `UNKNOWN` provider outcomes are reconciled through exact provider lookup and never dispatched again. Terminal provider evidence is content-addressed before its result event is queued.
- Claim-bound session messages and the `RUNNING` transition commit atomically. A delivery with a started transport and lost acknowledgement becomes `UNCERTAIN`; it is never blindly replayed. The worker checks `expires_at` both before persisting the transport-start marker and again immediately after that persistence, directly before invoking the gateway. Thus expiry while queued, across process restart, or during marker persistence is durably rejected without invoking the session gateway. The Control endpoint must still revalidate current ownership, expiry and session ACL at delivery time.
- Legacy worker database v1 migrates transactionally through schema v7. Rows without an owner epoch are retained with epoch `0` and excluded from delivery. Schema v5 stores provider execution-fence reservations; schema v6 adds an append-only per-execution project workspace ledger; schema v7 adds the exact pre-reservation fence-request journal. Existing provider intents/workspaces are retained, but legacy provider intents without a journaled fence request or persisted fence remain unresolved rather than having a reservation manufactured after an unknown historical side effect. Workspace allocations interrupted before v6 remain quarantined rather than being reallocated. Read-only health/metrics commands never create or migrate the database.

After a host crash or forced kill, start the service and inspect `health`, logs, provider reconciliation, and Control state. `UNKNOWN` and `UNCERTAIN` require exact external reconciliation or operator action. Do not delete the database or evidence directory to clear a stuck execution. Back up the database and artifact directory together; stop the service first so SQLite WAL is checkpointed cleanly.

## Security boundaries

- Claims are verified by Control and locally bound to worker ID, expiry, lease ID, owner epoch, immutable plan digest, command digest, provider payload digest, session message identity, and the signed `authenticator.acl_sha256` authorization-binding digest.
- Before sandbox start and provider dispatch, the supervisor requests an authoritative execution-fence reservation and validates the exact completion receipt. HTTP route adapters now exist in `runalith-control-api`, but the executable does not inject a durable `WorkerControlAuthority`; requests therefore fail closed with 503 until the host-owned lease/ACL/receipt transaction implementation is connected. This is not yet end-to-end enforcement.
- Result publication and session delivery require Control to revalidate lease, owner epoch, session membership and ACL at the transaction that accepts the event/message. The worker treats unclassified transport responses as ambiguous; server-side enforcement remains an external prerequisite.
- Provider dispatch uses stable provider/idempotency identity and exact preflight/postflight lookup. Ambiguous dispatch is persisted as `UNKNOWN`; no automatic replay occurs.
- Bubblewrap runs with explicit executable roots, an isolated writable workspace mount, no network fallback, an environment allowlist, command timeout, and bounded stdout/stderr. The sandbox profile digest binds the exact quota-workspace device/inode, project ID, and byte/inode limits; the launcher rejects replacement before exec. Kernel enforcement remains host-dependent and must be acceptance-tested on the provisioned mount before admitting untrusted workloads.
- **Node deterministic-task compatibility is not yet an end-to-end contract.** `runalith_domain::NodeDeterministicExecutionSpec` currently preserves/parses the legacy Node `execution` object as read-only metadata; the Worker does not consume or convert that object. Claim schema v3 instead binds a separate typed `CommandRequest` and its `command_sha256`. `CommandRequest` has no task-level `timeout_ms`; execution is bounded by the host `RUNALITH_WORKER_TIMEOUT_SECONDS` sandbox policy. Do not infer that Node's per-task timeout, optional execution fields, or side-effect/result semantics are preserved by the Worker claim. Control/Runtime owners must approve a versioned mapping and Node differential oracle before this boundary can be accepted; changing claim wire fields requires a versioned contract decision.
- Worker SQLite files use mode `0600`; newly created state directories use mode `0700`. Existing group/world-writable directories owned by the worker are secured to `0700`; paths containing symlinks are rejected.
- Control and provider HTTP calls use HTTPS, bounded response readers, bounded process deadlines, and curl config over stdin. `--disable` prevents ambient `.curlrc` settings from weakening TLS or request behavior.

## Independent build pipeline

`.github/workflows/runalith-worker.yml` is path-filtered to Worker, Control API, Store, Runtime, Linux quota, provider, sandbox and artifact changes. It runs formatting, focused tests and Clippy for the Store/Runtime/Control/Worker integration surface, while keeping the Worker dependency guard against `runalith-store` and `runalith-control-api`. It builds the Worker and privileged quota-helper/integration binaries and packages them with deployment units, examples and checksums. YAML and package/path assertions pass locally; a GitHub Actions run has not yet been observed. The workflow does not deploy to a production host. No production deployment has been performed as part of this implementation.

