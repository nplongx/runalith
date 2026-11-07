# Runalith Control host operations

**Status:** executable and locally acceptance-tested; compatibility host only, not a production-independent Part 1 deployment.

## Scope and authority limits

`runalith-control` is the standalone HTTP host for `runalith-control-api`. It opens the existing Rust schema-v20 Store, provides hash-only bearer authentication, serves the Control API on loopback, and supports explicit database initialization, health inspection, migration backup, cold restore and cooperative stop.

This process still opens the **combined compatibility SQLite Store**. It is not an isolated Control-owned database and does not prove the ADR 0003 three-database deployment boundary. Option B is the user-directed target architecture: Control, Execution and Governance own separate databases; Control retains only the minimum authenticated Governance approval-highwater projection needed for its local approval transaction; Governance remains authoritative for canonical trust/reviewer/nonce/decision state. However, no versioned Owner decision in the repository formally supersedes D-01 decision-register §11.3/§11.4, and Part 3 §278 requires that supersession before runtime database/transaction changes. Exact projection freshness/revocation, outbox/inbox, writer-fencing, migration and rollback contracts also remain open. Treat Option B as the target for planning, not production migration authorization. Do not create/split/copy/migrate databases until all owner decisions, contracts and migration acceptance are approved.

The binary injects deny-all approval, worker identity, result-producer and cancellation verifiers. It has no production trusted-skill catalog; skill-bearing roles fail closed. No `WorkerControlAuthority` is configured, so `/v1/worker/*` returns `503`. The binary can expose catalog CRUD/compile and create review-only workflow proposals (including exact catalog-plan instantiation); it cannot approve/admit/claim work, publish results, settle cancellation, dispatch workers or establish recovery disposition. A successful `/readyz` means only that the local Store passes schema/integrity/quarantine checks, not that production authority or execution is ready.

## Cancellation request versus execution settlement

`POST /v1/workflows/{workflow_id}/cancel` requires `workflow.cancel` and a host-injected `WorkflowCancellationVerifier`. The immutable request is persisted in the Workflow event journal and projected as `cancellation_request` on workflow reads. Exact actor/reason replay is idempotent; a changed request conflicts and still passes host authorization before replay is returned.

The projection has a `settlement_status` field. `NOT_REQUIRED` means the workflow was cancelled before any task attempt was issued. `UNRESOLVED` means at least one execution attempt exists and the Execution-owned settlement receipt has not been accepted. This is derived from durable attempt history, not worker liveness or lease expiry. It remains `UNRESOLVED` after a late exact result or when every visible task appears finished; no receipt means no cancellation settlement.

Every durable task claim increments the task attempt and owner epoch in the same immediate transaction that records its claim event. Both direct and coordinator `task.claimed` payloads carry the exact `leaseId`, `attempt`, `ownerEpoch`, worker identity and expiry; the epoch is not inferred later from a mutable task projection. The Store regression `direct_task_claim_journal_event_binds_owner_epoch` checks that direct-claim event identity matches the returned lease.

For a workflow that has not entered execution, an authorized cancellation may move `PROPOSED`/`APPROVED` to terminal `CANCELLED`. Once state is `EXECUTING`, Control records only the request: it retains `EXECUTING`, all running lease IDs and owner epochs, blocks new direct/coordinator claims, and does not claim that a worker process stopped. A valid in-flight result under the exact current lease may still be recorded, but it does not independently terminalize the workflow while cancellation is pending. A stale lease remains fenced. No timeout, cancellation request, acknowledgement or worker metadata releases an active lease.

The standalone binary's cancellation verifier is deny-all. Giving a principal `workflow.cancel` does not grant process-stop/settlement authority: the route responds `503` and leaves workflow projection and event journal unchanged. Production activation requires a versioned Execution contract distinguishing cancellation acceptance ACK from process-stop receipt, exact attempt/lease/epoch/process identity and plan binding, authoritative no-more-side-effects evidence, signer/idempotency/replay semantics, and a transaction that atomically settles the lease and workflow state. Those authorities/contracts are not currently provisioned; executing cancellation remains nonterminal and unresolved.

## Read-only recovery inspection

`GET /v1/workflows/{workflow_id}/tasks/{task_id}/recovery` requires `workflow.recovery.read`, a capability separate from `workflow.read`. It returns the exact `TaskAttemptSnapshot` captured from the local Store and always labels disposition `UNRESOLVED`, authority `host_runtime_inventory_required`, and `mutated: false`. The snapshot includes current lease ID/owner epoch/expiry, complete attempt ledger, provider intent and observation history, session binding/history, bounded journal events, chain head and `history_complete`. Incomplete local history is explicit. This is an observation endpoint, not a recovery decision: no lease, expired lease, absent session binding, or missing provider observation never establishes worker death or authoritative remote absence. No endpoint here terminalizes a workflow or releases a lease.

Store schema v20 adds an append-only cancellation request timestamp/event projection. The explicit v19→v20 migration reopens previously false-terminal `CANCELLED` workflows that have execution attempts into `EXECUTING` for reconciliation, preserving their original leases and epochs. Pre-execution terminal cancellations remain terminal. Migration verifies exact request event, actor/reason, immutable plan binding and event-chain integrity; missing or invalid evidence aborts and rolls back the schema/data changes. This does not manufacture a process-stop receipt or settle the request.

The API request boundary is intentionally strict: both `ControlApi::handle` body decoding and the TCP parser enforce the 1 MiB body limit, so in-process hosts cannot bypass the wire limit. Raw JSON is recursively scanned for duplicate object keys before typed deserialization, including nested `Value` fields and escaped spellings that decode to duplicate names. The HTTP parser rejects duplicate `Content-Length`, `Host`, `Content-Type` and authorization headers, unsupported `Transfer-Encoding`, malformed lengths/request lines, oversized headers/bodies and unsupported content types. Keep a TLS terminator in front of the loopback-only listener; parser hardening does not establish external transport identity.

## Files and permissions

Install the executable at `/usr/local/bin/runalith-control`, the unit at `/etc/systemd/system/runalith-control.service`, and the environment at `/etc/runalith/control.env`. Create `runalith-control` system user/group before enabling the unit. Use an owner-only state/runtime directory and auth file:

```sh
sudo install -d -o runalith-control -g runalith-control -m 0700 /var/lib/runalith-control
sudo install -d -o root -g runalith-control -m 0750 /etc/runalith
sudo install -o root -g runalith-control -m 0600 rust/deploy/control/control.env.example /etc/runalith/control.env
sudo install -o runalith-control -g runalith-control -m 0600 rust/deploy/control/control-auth.example.json /etc/runalith/control-auth.json
```

Replace the all-zero `token_sha256` example with the SHA-256 digest of a cryptographically random bearer token. Keep plaintext token only in an approved client secret manager. Example one-time generation in a private terminal; record the token in the secret manager before unsetting it:

```sh
TOKEN="$(openssl rand -hex 32)"
printf '%s' "$TOKEN" | sha256sum
unset TOKEN
```

Copy only the first field (64 lowercase hex characters) into `token_sha256`. Auth file schema is closed (`version: 1`, exact `principals` fields); duplicate token digests, invalid capabilities, symlinks, non-regular files, oversize files and group/world-readable auth files are rejected. Bearer comparison hashes the presented token and compares its digest to the configured entries. Capability grants are exactly those in the auth file; tokens are not self-describing JWTs and no external issuer is contacted.

The example capabilities are intentionally limited. Do not grant `workflow.approve`, `workflow.admit`, `workflow.schedule`, `worker.*`, `workflow.cancel` or `workflow.result.publish` to this binary: the corresponding production authorities are not configured. The example file's zero digest is a placeholder and cannot authenticate a real token.

## Reproducible install and service smoke test

Build the release binary, then run the disposable install harness from the Rust workspace root:

```sh
cargo build --release --locked --offline -p runalith-control-api
deploy/control/smoke-test-install.sh target/release/runalith-control
```

The harness copies the release binary into a temporary `/usr/local/bin` prefix, writes private throwaway auth/environment files, renders the systemd unit with the current non-root user and temporary writable paths, runs `systemd-analyze verify` and offline `systemd-analyze security`, then exercises `init-db`, pre-start `health`, real `serve`, `/readyz`, authenticated `/health`, worker-authority fail-closed behavior, concurrent-start exclusion, invalid cold-restore rejection, SIGKILL recovery and graceful stop. A real listener-bind failure must remove its PID marker and permit a subsequent start using the same database and address. When a user systemd manager is available, the harness also runs the copied binary as a transient **user-scope** service: it verifies authenticated readiness, sends SIGKILL to the main process and waits for systemd restart with a new PID, performs a clean `systemctl --user restart`, then stops through `ExecStop` and verifies database health. The harness removes both temporary prefix and user-runtime state on exit. It does not alter `/usr/local`, create system service users, install a system-scope unit under `/etc/systemd/system`, enable a boot service, or activate production. This is reproducible local process and transient user-service acceptance, not a production host deployment or global D-01 writer-fence test.

## Build and first start

From `rust/`:

```sh
cargo build --release --locked -p runalith-control-api
sudo install -o root -g root -m 0755 target/release/runalith-control /usr/local/bin/runalith-control
sudo install -o root -g root -m 0644 deploy/control/runalith-control.service /etc/systemd/system/runalith-control.service
```

For a **new, explicitly authorized local D-01 test Store only**, initialize the schema once as the service user:

```sh
sudo -u runalith-control env \
  RUNALITH_CONTROL_DATABASE_PATH=/var/lib/runalith-control/workflow.db \
  /usr/local/bin/runalith-control init-db
```

`init-db` refuses to replace an existing path. It applies current Store migrations only to a newly created database. Do not initialize a separate production DB as a workaround for D-01/ADR 0003 conflict.

Enable and inspect service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now runalith-control.service
sudo systemctl status runalith-control.service
curl --fail http://127.0.0.1:8090/livez
curl --fail http://127.0.0.1:8090/readyz
```

The listener rejects non-loopback addresses. For remote clients, terminate TLS at an independently secured local reverse proxy and proxy only to `127.0.0.1:8090`; do not expose plain HTTP or trust caller-supplied forwarded identity headers. API routes require `Authorization: Bearer <token>`; `/livez` and `/readyz` are minimal unauthenticated probes and reveal no workflow data.

`/readyz` checks Store schema version 20, SQLite `quick_check(1)`, `foreign_key_check`, and the irreversible D-01 checkpoint-quarantine marker. Any mismatch/quarantine returns `503`. It does not check upstream Governance trust roots, worker liveness, provider state, trusted-skill source availability, external checkpoint custody or cross-part contract compatibility.

## Lifecycle commands

```sh
runalith-control version
runalith-control health
runalith-control migrate-db /var/lib/runalith-control/pre-migration.db
runalith-control restore-db /var/lib/runalith-control/pre-migration.db
runalith-control stop
```

`health` is read-only and returns exit code `2` for an absent, unsupported, unsafe or unhealthy database. `stop` writes a private shutdown marker and waits up to 30 seconds for the server to drain and remove its PID marker; the systemd unit uses it as `ExecStop`. The host also keeps a persistent owner-only `control.lock` inode and acquires a non-blocking exclusive `flock` for the full process lifetime and every offline maintenance command. Do not delete or replace this lock file while the service may run: deleting a locked inode can split the lock domain.

A crash/SIGKILL releases the kernel lock but may leave `control.pid`. The next Control process first acquires `control.lock`, then validates the marker's owner, mode, inode and PID. It removes the marker only when the recorded PID is confirmed absent. A live PID, permission denial, malformed marker, symlink or ownership mismatch remains fail-closed and requires operator investigation; it is never blindly overwritten. `standalone_control_restarts_after_sigkill_and_recovers_stale_pid_marker` kills a live server, proves the marker remains, starts a second real process, verifies readiness and authenticated health, then drains it cleanly. The systemd unit sets `RuntimeDirectoryPreserve=yes`, so the lock inode remains available for offline maintenance after `systemctl stop`; systemd removes `/run` state on reboot. Without systemd, the lock file remains until its private runtime directory is removed by its owner.

## Migration and backup

Startup never migrates. `migrate-db BACKUP_PATH` is explicit and:

1. Acquires the same persistent advisory lock used by `serve`, preventing this Control binary from starting concurrently; the `.pid` file remains a process marker, not the lock primitive.
2. Makes a SQLite `VACUUM INTO` snapshot at a new absolute destination; it refuses overwrite.
3. Sets backup mode `0600` and verifies the backup's original `user_version` and `quick_check`.
4. Calls the Store's explicit migration transaction, then checks live readiness.

Current Store migration code supports the Rust schema upgrade path v2–v20. The standalone executable's process-level migration test covers a populated v17 backup upgraded to v20 and verified backup preservation. Store tests cover the reconstructed populated v8→v20 path and the additive v18→v19 lease-renewal/execution-fence ledgers and v19→v20 cancellation-settlement recovery. These are local fixtures, not an externally sourced Node database import or production migration rehearsal.

**Critical D-01 condition:** the maintenance advisory lock excludes only this Control binary. It is not a global writer barrier. Before migration, all processes that can open/write the shared D-01 file must be stopped and fenced by the actual host/operator procedure: Node runtime, MCP, Control, Execution/Worker, Governance, schedulers and maintenance jobs. This binary cannot verify their absence. If their state cannot be established, do not migrate. Do not run two schema owners concurrently.

Example, only after the complete D-01 writer set has been stopped:

```sh
sudo systemctl stop runalith-control.service
sudo -u runalith-control env \
  RUNALITH_CONTROL_DATABASE_PATH=/var/lib/runalith-control/workflow.db \
  RUNALITH_CONTROL_PID_FILE=/run/runalith-control/control.pid \
  /usr/local/bin/runalith-control migrate-db /var/lib/runalith-control/pre-migration.db
```

The command refuses an existing backup destination. On migration failure, it reports the verified backup path; retain both files and do not attempt automatic restart until the schema and backup are inspected.

## Restore and rollback boundary

`restore-db BACKUP_PATH` is an explicit **cold restore into a path that does not exist**. It does not replace an existing database and is not an online rollback. The command:

1. Acquires the same persistent advisory lock used by `serve` and `migrate-db`.
2. Requires a canonical private parent, an owner-only regular non-symlink backup file, and a separate destination path that does not exist.
3. Rejects SQLite `-wal`/`-shm` sidecars at both source and destination. It will not guess whether stale WAL state is safe to discard.
4. Verifies the backup is exactly schema v20, passes `PRAGMA quick_check`, has no `PRAGMA foreign_key_check` rows and does not contain the durable D-01 checkpoint-quarantine marker.
5. Copies to a create-new mode-0600 temporary file in the destination directory, fsyncs and re-verifies it, opens it through `Store::open_existing`, and checks Store readiness.
6. Publishes with an atomic same-filesystem hard link. Existing destinations are never overwritten. The source backup is retained; the published database is reopened and readiness-checked.

The restore CLI accepts only the current schema-v20 backup. It does not downgrade schemas or reverse a migration to an older Rust schema. `standalone_restore_recovers_persisted_workflow_without_overwriting_database` exercises a real source process, persisted workflow, cold restore, refusal to overwrite, health, and a second real Control process reading the restored workflow. This is local process acceptance, not production rollback proof.

Example, only after the complete D-01 writer set has been stopped and fenced:

```sh
# Preserve the current DB and any WAL/SHM files as an operator-controlled archive.
# The target path and its -wal/-shm sidecars must be absent.
sudo -u runalith-control env \
  RUNALITH_CONTROL_DATABASE_PATH=/var/lib/runalith-control/workflow-restored.db \
  RUNALITH_CONTROL_PID_FILE=/run/runalith-control/control.pid \
  /usr/local/bin/runalith-control restore-db /var/lib/runalith-control/pre-migration.db
sudo -u runalith-control env \
  RUNALITH_CONTROL_DATABASE_PATH=/var/lib/runalith-control/workflow-restored.db \
  /usr/local/bin/runalith-control health
```

**Critical D-01 condition:** the maintenance advisory lock excludes only this Control binary; it does not fence Node, MCP, Execution/Worker, Governance, schedulers, maintenance jobs or other processes opening the shared database. Stop and fence the complete D-01 reader/writer set externally before taking, migrating or restoring a backup. Restore does not make split-brain or stale WAL state safe. Restoring an earlier snapshot discards subsequent database changes; coordinate provider, process, message and other external side effects separately. Do not attempt per-part rollback while parts still share D-01 persistence.

Do not clear `agg_checkpoint_store_quarantine` by editing SQLite; only a separately authorized reconciliation/recovery procedure may release that state.

## Operational blockers

- Option B is selected under ADR 0003, but Control/Execution/Governance DB extraction and the Control-owned D-01 approval-highwater projection contract are not implemented.
- No production principal provider, approval verifier/signing authority, trusted-skill resolver, worker/result/cancellation authority or worker Control backend.
- No cancellation ACK/process-stop receipt/lease settlement or authoritative cross-part recovery receipt.
- No approved typed Control-to-Execution deterministic local-step contract or production executor composition. Worker claim v3 binds a separate `CommandRequest` without task-level `timeout_ms`; current Worker applies host `RUNALITH_WORKER_TIMEOUT_SECONDS`. A versioned timeout mapping/override and deadline/error differential contract remain outstanding.
- No distributed same-task retry protocol. Node currently performs task/job, session TAKEOVER, active-lease exclusion, attempt supersession, session-attempt increment and retry-event persistence in one SQLite savepoint; split Control/Execution ownership requires an approved versioned reserve/settle/outbox/inbox/UNKNOWN contract.
- Part 2 Worker schema v7 now journals the exact provider `ExecutionFenceRequest` before Control reservation. Restart can replay that exact idempotent reservation and perform provider lookup only, without redispatch. This closes a bounded Worker-side reservation ambiguity but is not cancellation/process-stop proof, provider terminality evidence, or Control lease-settlement authority.
- No full Node lifecycle/catalog/evaluator differential run, externally sourced historical import rehearsal, production D-01 writer-barrier proof, production rollback rehearsal, or independent clean-host deployment evidence. Cold restore is exercised only against a disposable schema-v20 fixture.

The temporary-prefix smoke harness also invokes the installed release binary with a malformed schema snapshot and verifies failure, unchanged source bytes and no target database. It checks worker routes remain 503 when `WorkerControlAuthority` is not provisioned. The real-process restore test covers the same failure boundary. The harness activates a transient **user-scope** systemd service when a user manager is available, then verifies readiness/auth, SIGKILL auto-restart with a new PID, clean restart, graceful `ExecStop` and database health. `systemd-analyze verify/security` also checks the rendered unit offline. This does not install or activate the system-scope production unit.

The process is useful for local API integration and process acceptance. It does not authorize production worker dispatch or rollout.
