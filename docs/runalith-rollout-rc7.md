# RC.7 rollout readiness and rollback runbook

This runbook describes the **local host-managed plugin upgrade** from RC.5 to the versioned RC.7 candidate. The workflow here verifies package identity and simulates atomic generation changes in a private test directory. It deliberately has no command that edits Chat On Steroids' plugin registry, installs a package, stops a process, or mutates the live workflow database.

## 1. Build and pin the exact candidate

Build to a new, non-overwriting path. Keep the exact archive and SHA-256 emitted by the successful build together; a different source state or rebuilt archive is a different candidate.

```bash
OUT="/tmp/runalith-1.0.9-rc.7-candidate-$(date -u +%Y%m%dT%H%M%SZ).mcpb"
PLUGIN_BUNDLE_OUT="$OUT" bash scripts/package-runalith-mcpb.sh
sha256sum "$OUT"
node scripts/test-mcpb-candidate.mjs "$OUT"
```

The package verifier checks ZIP entry types and names, manifest/package agreement, selected entry-point presence, exact source-to-archive byte alignment, extracted-runtime initialization, `tools/list`, `orchestrator_health`, and the packaged regression suite. It retains `server/index.js` as a historical input with its pinned SHA-256; the runtime entry point for RC.7 is `server/index-v1.0.9-rc.7.js`.

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

The command performs candidate and rollback extracted-runtime smoke tests, checks registry/package/process identity, reads the workflow database through SQLite's read-only mode, verifies `quick_check` and foreign keys, and counts jobs, running tasks, and active unexpired task leases. The report is JSON and explicitly records that no live mutation occurred. Exit code `3` means the activation gate is blocked; inspect the `decision.blockers` rather than treating a successfully completed preflight command as rollout approval.

**Activation must remain blocked while work is active.** Wait for jobs to reach their normal terminal lifecycle through their current owner. Do not kill the plugin child, rewrite job/task states, expire leases manually, or change counters to force the gate open. Then rerun preflight and verify the exact same candidate and rollback hashes.

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

There is no repository command for live activation. After preflight returns `READY_FOR_HOST_MANAGED_ACTIVATION`, an authorized operator must import/update the exact MCPB through Chat On Steroids' plugin UI. Do not edit `state/plugins.json` directly or replace files beneath the active `g-*` generation: the running process already loaded that generation and the host manages generation identity.

After the host reports the update complete, run:

```bash
node scripts/runalith-rollout.mjs verify-installed --candidate "$OUT"
sha256sum "$OUT"
```

The file comparison must report `FILES_MATCH_EXACTLY`, the registry and package versions must both be RC.7, and the active process command line must use `server/index-v1.0.9-rc.7.js`. Then use the **host-connected live MCP client** to query `orchestrator_health` and `workflow_list` read-only, and compare live DB counts/state with the preflight baseline. File parity alone does not reveal a hash of the original host-stored MCPB container and is not a substitute for the live health query. Preserve the source archive's own SHA-256 in the rollout record before switching.

If any version, entry point, file digest, health result, or workflow-state comparison differs, stop further progression. Use the host UI to restore the verified rollback snapshot, then repeat post-checks against that rollback bundle. The repository does not attempt a live rollback automatically because the host owns the process lifecycle.

## 6. Acceptance gates and known limits

RC.7 includes runtime guards that keep Plan Graph review approval separate from execution authorization, make an approved Plan Graph wrapper non-dispatchable, require an approved/pinned Plan Graph before Execution Graph proposal creation, and block Execution Graph dispatch unless a current candidate, trusted reviewer attestation, exact immutable plan, and approval are revalidated. These contracts are exercised in a disposable SQLite database.

Even after rollout, **the actual Goal/Idea → Plan → Execution Graph chain is not operational until real evidence exists**. Every required Plan Graph step must bind current typed evidence to a successful producer task/result/attempt and completion event; file-byte integrity does not verify claim truth or independence. Reviewer identity must be signed by a configured trusted provider. No candidate/runtime test can create those missing live facts. Do not synthesize evidence, approval, tasks, artifacts, or an Execution Graph to make a dashboard look complete.
