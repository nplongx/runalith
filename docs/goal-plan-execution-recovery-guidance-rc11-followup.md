# Goal/Plan/Execution recovery guidance — RC.11 follow-up

## Read-only reconciliation

Run the diagnostic against a canonical workflow database path and a new output path:

```sh
node scripts/reconcile-active-workflows.mjs --db "$HOME/.chat-on-steroids/agent-orchestrator/workflow.db" --limit 200 --stale-after-ms 900000 --out artifacts/adaptive-goal-graph/reconciliation-<unique-id>.json
node --test tests/test-reconcile-active-workflows.mjs
```

The CLI opens SQLite read-only and writes only the new report. It refuses to overwrite existing output and rejects symlinked database paths. The report correlates job/task/attempt/result/artifact/lease/event identifiers, scans all durable job events for task correlation, checks event references against durable attempt/result/artifact rows, checks lease attempt against task execution attempt, flags artifact job/producer-role mismatches, reports evidence truncation, and emits a deterministic per-observation recovery-plan key.

Every recovery plan is `HOLD_FOR_OWNER_RECONCILIATION`, `authorizationGranted:false`; every task has `automaticLifecycleActionAuthorized:false`. `lifecycleEvidence.disposition=HOLD_CONFLICTING_EVIDENCE` means at least one persisted invariant conflicts. A missing owner, provider, runtime identity, result, artifact, event reference, or lease is not proof that a worker is dead or that a task may be retried.

## Required per-job/task procedure

For each `EXECUTING` job and running task:

1. Re-query the current job/task rows and every event, attempt, result, artifact, approval and lease ID in the report. Resolve event-referenced IDs against the correct job/task; check attempt/run IDs, result outcome, artifact producer role/content hash, and timestamp ordering.
2. Verify responsible owner through host-owned records. `conversation_key`, worker ID, provider run/session ID, and `/proc` observations are correlation hints, not authenticated ownership.
3. Query the provider/runtime independently for the exact run identity and execution state. A PID or command hash is not sufficient without a persisted identity binding.
4. Check lease fencing, owner epoch and attempt number. A missing lease or expired timestamp does not prove the worker stopped.
5. If any required evidence is missing or conflicting, preserve state as `UNKNOWN`/`CONFLICTING`; obtain the responsible owner/provider operator's evidence. Do not bulk-reset, terminalize, retry, approve, dispatch, or kill a process.
6. Only the authorized workflow owner may select an existing documented lifecycle transition after evidence is complete. Re-run reconciliation after that authorized action and compare the deterministic observed-identity key.

The latest read-only inventory is `artifacts/adaptive-goal-graph/live-reconciliation-20261026T1810+0700-rc11-followup.json`. It observed 136 jobs, 5,304 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 118 approvals and zero lease rows. The active inventory included 60 `EXECUTING` jobs and 61 running tasks; all 61 lacked persisted execution metadata, had unresolved authoritative owner/provider identity, and had no lease rows. No lifecycle action is authorized by these observations.

## External checkpoint verifier contract

`scripts/lib/external-trust-checkpoint-contract.mjs` validates an Ed25519-signed `host-monotonic-trust-ledger-checkpoint/v1` response, request nonce, exact candidate/rollback hashes, freshness, checkpoint sequence, and previous-digest continuity. `tests/test-external-trust-checkpoint-contract.mjs` uses generated disposable keys to test signature tampering, replay, stale responses, release substitution, rollback, chain discontinuity and untrusted continuity source.

This is protocol validation, not a production authority. The module always reports `productionAuthorityEstablished:false`. The host/security authority must provision a root-owned adapter and public key outside the plugin's writable tree; authenticate the adapter/transport; provide a live challenge response backed by an independently protected monotonic store; verify effective host runtime loading; and independently attest the adapter identity and trust root. A JSON report, local SQLite state, test key, or caller-supplied `verified` flag cannot close `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`.

## Trust configuration and release boundary

Provision `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` through host-owned configuration loading. The source verifier and reviewer require distinct provider IDs and disjoint Ed25519 public roots, exact domain/scope, monotonically increasing config versions, validity windows, and audited rotation/revocation. Offline schema validation does not prove host-effective loading or independent administration.

The latest runtime candidate remains RC.11; this follow-up changes diagnostics/tests/docs only, not packaged runtime code, so no successor package was issued. RC.11 archive/source-alignment evidence refers to its recorded source snapshot; do not interpret it as a new alignment result for this follow-up working tree. Production rollout remains `BLOCKED` until trust configuration, external monotonic anchoring, and authoritative workflow/task reconciliation are independently verified.
