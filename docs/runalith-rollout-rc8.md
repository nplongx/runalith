# RC.8 rollout readiness and rollback runbook

This runbook describes the **local host-managed plugin upgrade** from RC.5 to the versioned RC.8 candidate. The workflow here verifies package identity and simulates atomic generation changes in a private test directory. It deliberately has no command that edits Chat On Steroids' plugin registry, installs a package, stops a process, or mutates the live workflow database.

## 1. Build and pin the exact candidate

Build to a new, non-overwriting path. Keep the exact archive and SHA-256 emitted by the successful build together; a different source state or rebuilt archive is a different candidate.

```bash
OUT="/tmp/runalith-1.0.9-rc.8-candidate-$(date -u +%Y%m%dT%H%M%SZ).mcpb"
PLUGIN_BUNDLE_OUT="$OUT" bash scripts/package-runalith-mcpb.sh
sha256sum "$OUT"
node scripts/test-mcpb-candidate.mjs "$OUT"
```

The package verifier checks ZIP entry types and names, manifest/package agreement, selected entry-point presence, exact source-to-archive byte alignment, extracted-runtime initialization, `tools/list`, `orchestrator_health`, and the packaged regression suite. It retains `server/index.js` as a historical input with its pinned SHA-256; the runtime entry point for RC.8 is `server/index-v1.0.9-rc.8.js`.

## 2. Pin and verify a rollback package

Prefer the exact RC.5 archive named by the host registry whenever its stored source path is absolute and the file still exists. Verify that archive in an isolated process and compare its contents against the active generation:

```bash
ROLLBACK="/absolute/registry-source/path/to/the-original-rc5.mcpb"
sha256sum "$ROLLBACK"
node scripts/test-mcpb-candidate.mjs "$ROLLBACK"
node scripts/runalith-rollout.mjs verify-installed --candidate "$ROLLBACK"
```

Only accept this as a rollback package when its version matches the installed baseline, the extracted-runtime smoke passes, and installed file parity reports `FILES_MATCH_EXACTLY` with zero mismatches.

If that original archive is unavailable, capture a content-derived snapshot instead:

```bash
ROLLBACK="/tmp/runalith-installed-generation-rollback-$(date -u +%Y%m%dT%H%M%SZ).mcpb"
node scripts/runalith-rollout.mjs backup-installed --out "$ROLLBACK"
sha256sum "$ROLLBACK" "$ROLLBACK.manifest.json"
```

The snapshot helper reads the generation used by the host-owned plugin process and compares every captured regular file against the new archive. It refuses symlinks, ambiguous process identity, path collisions, overwrite of an existing output, and a change to the pinned historical `server/index.js`. A sidecar JSON lists the observed source generation, every file digest, archive digest, and limitations. This is a **content-derived snapshot**, not the original MCPB container bytes and not publisher provenance; never describe its hash as the original package hash.

## 3. Run the non-mutating preflight

Supply the exact candidate hash from step 1 and the rollback archive from step 2:

```bash
node scripts/runalith-rollout.mjs preflight \
  --candidate "$OUT" \
  --expected-sha256 "<exact-sha256-from-build>" \
  --rollback-bundle "$ROLLBACK"
```

The command performs candidate and rollback extracted-runtime smoke tests, checks registry/package/process identity, reads the workflow database through SQLite's read-only mode, verifies `quick_check` and foreign keys, counts jobs/running tasks/active unexpired task leases, and reads only the six whitelisted trust-configuration variables from the active runtime's process environment. It validates both versioned JSON trust documents, current key validity and distinct provider IDs/public roots without printing PEM values. Missing, malformed or legacy-only trust environment is a `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` blocker, even if all workflows have drained. A second hard gate, `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`, remains until a host-managed independently protected monotonic checkpoint is actually provisioned and independently verified; the current repository has no such source or verifier and intentionally does not synthesize one. These checks verify configuration shape and runtime environment presence, not human authority or independent provider operation. The report is JSON and explicitly records that no live mutation occurred. Exit code `3` means the activation gate is blocked; inspect `decision.blockers` rather than treating a successfully completed preflight command as rollout approval.

### Owner-guided job reconciliation report

For a host with stale `EXECUTING` jobs, capture a read-only reconciliation report before asking an owner to select a recovery path. This is a repository operator script, not an MCP state-changing tool:

```bash
DB="$HOME/.chat-on-steroids/agent-orchestrator/workflow.db"
REPORT="/tmp/runalith-active-workflow-reconciliation-$(date -u +%Y%m%dT%H%M%SZ).json"
node scripts/reconcile-active-workflows.mjs \
  --db "$DB" --limit 200 --stale-after-ms 900000 --out "$REPORT"
sha256sum "$REPORT"
```

It opens SQLite with `readOnly: true`, rejects non-canonical/symlink database paths, and only creates a new output file (mode `0600`; existing paths are never overwritten). For each active job it correlates the current task pointer and status with `attempts`, result IDs/outcomes, typed artifact IDs/status/content hashes, recent events, approval decision/hash, worker/session/PID fields, task-lease attempt/worker/heartbeat/expiry and runtime state. It flags contradictions such as `RUNNING_TASKS_WITHOUT_ACTIVE_LEASES`, `ACTIVE_TASK_POINTER_NOT_RUNNING`, `COMPLETION_EVENT_NEWER_THAN_ACTIVE_TASK_ROW`, or `EXECUTING_JOB_WITHOUT_RUNNING_TASKS`. Result bodies and approval raw text are deliberately omitted. The report does not decide which contradictory row is authoritative, confirm external provider state, alter lifecycle or authorize a retry. Compare its exact IDs/timestamps against `workflow_get`, `workflow_events`, `workflow_diagnose`, host-side agent/provider identity and the responsible owner; preserve attempt/result/event lineage and use an authorized documented lifecycle path only after the actual outcome and authority are established.

**Activation must remain blocked while active-job state is unresolved.** Before assuming work will drain on its own, run `workflow_liveness_diagnostics` and the reconciliation report above, then inspect `workflow_get`, `workflow_events`, `workflow_diagnose` and host-side worker state with each responsible owner. A `stale_candidate` flag or zero active leases is not proof that a worker is dead or permission to terminalize. The read-only report may show conflicting task/attempt/result/event signals; it is intentionally not a resolver. Preserve attempt/result/event lineage and resolve only through a documented, authorized lifecycle path after the underlying outcome is established. Never bulk-reset SQLite, kill the host-owned plugin child, rewrite job/task state, expire leases manually, or alter counters to force the gate open. Then rerun preflight and verify the exact same candidate and rollback hashes.

## 4. Exercise switch, health failure, and rollback without touching the host

```bash
node scripts/runalith-rollout.mjs simulate --candidate "$OUT"
node scripts/runalith-rollout.mjs simulate --candidate "$OUT" --failpoint after-stage
node scripts/runalith-rollout.mjs simulate --candidate "$OUT" --failpoint after-switch
node scripts/runalith-rollout.mjs simulate --candidate "$OUT" --failpoint health-check
```

Each run uses a disposable `/tmp/runalith-rollout-test-*` directory and a synthetic active-generation marker. The success path stages and hashes the candidate, atomically replaces the simulated marker, checks the simulated health response and exact readback, and proves repeat execution is idempotent. Failpoints before switch leave the prior marker untouched; failpoints after switch restore and reread the exact prior marker. A failpoint run intentionally returns a non-zero CLI exit while reporting `ROLLOUT_FAILED_ROLLED_BACK`.

These are tests of the rollout state machine, not proof that the host application can hot-swap a process that it owns. The app, not this repository, selects the plugin generation and controls process lifecycle.

## 5. Authorized host-managed installation and post-check

There is no repository command for live activation. After the active runtime inherits both schema-valid JSON trust configurations from the supported host-managed environment mechanism and preflight returns `READY_FOR_HOST_MANAGED_ACTIVATION`, an authorized operator must import/update the exact MCPB through Chat On Steroids' plugin UI. The first RC.8 process initializes its separate trust-ledger database from the validated configuration; the status tool subsequently shows the recorded high-water versions. Do not edit `state/plugins.json` directly or replace files beneath the active `g-*` generation: the running process already loaded that generation and the host manages generation identity. The repository has not independently established that the host UI can provision these environment variables; that must be verified by an authorized operator before activation.

After the host reports the update complete, run:

```bash
node scripts/runalith-rollout.mjs verify-installed --candidate "$OUT"
sha256sum "$OUT"
```

The file comparison must report `FILES_MATCH_EXACTLY`, the registry and package versions must both be RC.8, and the active process command line must use `server/index-v1.0.9-rc.8.js`. Then use the **host-connected live MCP client** to query `orchestrator_health` and `workflow_list` read-only, and compare live DB counts/state with the preflight baseline. File parity alone does not reveal a hash of the original host-stored MCPB container and is not a substitute for the live health query. Preserve the source archive's own SHA-256 in the rollout record before switching.

If any version, entry point, file digest, health result, or workflow-state comparison differs, stop further progression. Use the host UI to restore the verified rollback snapshot, then repeat post-checks against that rollback bundle. The repository does not attempt a live rollback automatically because the host owns the process lifecycle.

## 6. Acceptance gates and known limits

RC.8 adds a persisted Goal/Idea Graph snapshot verifier. It reconstructs current nodes and every immutable revision, explicit membership provenance, typed edges and durable evidence lineage; verifies an external Ed25519 signature against a configured trust root; and binds the attested snapshot/evidence-manifest hashes into Plan and Execution Graph readback. Plan Graph review approval stays non-dispatchable, and Execution Graph dispatch remains blocked without the current source attestation, trusted action reviewer, exact immutable plan and approval. These contracts are exercised in disposable SQLite.

The trust onboarding path is schema-validated and administrator-managed. Prefer `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON`; see [the full AGG trust contract](adaptive-goal-graph.md#administrator-managed-trust-configuration-and-rotation). Validate the pair in both directions, for example `node scripts/validate-agg-trust-config.mjs --domain goal_idea_verifier --config /secure/admin/source-verifier-trust.json --peer-config /secure/admin/action-reviewer-trust.json` and the corresponding reviewer command with the files reversed. A one-file `PASS` without `--peer-config` means `SINGLE_CONFIGURATION_ONLY`, not pair acceptance. `trust_root_sha256` in versioned JSON-config attestations is SHA-256 of canonical DER-encoded SPKI bytes, so alternate PEM formatting cannot turn the same Ed25519 key into two independent roots. The two domains must have distinct provider IDs and disjoint canonical public-key fingerprints. RC.8 hardening adds controlled overlap rotation, immediate root revocation, validity checks, config-version anti-rollback, per-version public-root manifest and append-only rejection events in a separate local trust ledger. It never provisions trust automatically and does not import private keys. The host environment mechanism must be confirmed by an authorized operator; this repository cannot assert the host UI accepts these settings.

### External trust-ledger anchor contract (not yet implemented by the host)

The local SQLite ledger is not a root of trust for its own anti-rollback guarantee: restoring an older whole database restores its high-water mark too. To remove the external-anchor blocker, the host administrator/security owner must name and provision an authority independent of the plugin's data directory—preferably a host-managed monotonic checkpoint service backed by protected storage/HSM and controlled by the release/trust administrators. Its independently verified report must have `status: "VERIFIED"`, `source: "host_monotonic_checkpoint_service"`, a non-empty `authorityId`, positive `checkpointSequence`, SHA-256 `checkpointDigest`, `previousCheckpointDigest`, `ledgerStateSha256`, `trustDomainStateSha256`, exact `candidateSha256` and `rollbackSha256`, `signatureVerified: true`, `independentOfLocalLedger: true`, and canonical `observedAt` no more than five minutes old. The signed checkpoint must bind the verifier and reviewer domains, their approved config versions and canonical root-manifest fingerprints, a strictly increasing checkpoint sequence, the current ledger identity/high-water state, issue time, and previous-checkpoint digest. The verification public key and authority identity must be provisioned through a separately authenticated host administration channel, not embedded from this repository or supplied by an untrusted plugin caller. The current CLI validates this report shape and exact release-hash binding only; it does **not** cryptographically verify a checkpoint, and therefore its live implementation always returns `NOT_CONFIGURED` until the host verifier integration exists.

Before this can be considered satisfied, the host must publish a supported provisioning/read API and a verification contract; the repository must then verify signature, authority, domain/provider separation, monotonic sequence, current ledger/checkpoint binding, freshness and rollback/replay behavior, with negative tests for missing, stale, malformed, revoked-key, lower-sequence, same-sequence/different-content and ledger-restore cases. The host plugin manager must enforce the result at activation time and bind it to the exact candidate and rollback SHA-256 values. No such supported API, anchor key, or host UI contract is currently observed. Therefore the preflight deliberately reports the anchor as `NOT_CONFIGURED` and fails closed; a local test fixture setting `verified: true` is test coverage only, not production evidence.

Even after rollout, **the actual Goal/Idea → Plan → Execution Graph chain is not operational until real evidence exists**. Every required Plan Graph step must bind current typed evidence to a successful producer task/result/attempt and completion event; file-byte integrity does not verify claim truth or independence. Reviewer identity must be signed by a configured trusted provider. No candidate/runtime test can create those missing live facts. Do not synthesize evidence, approval, tasks, artifacts, or an Execution Graph to make a dashboard look complete.
