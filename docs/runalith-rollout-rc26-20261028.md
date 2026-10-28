# Runalith RC.26 rollout dossier — 2026-10-28

## Decision

**`BLOCKED`; do not activate RC.26 or dispatch production.** RC.26 contains reconciliation and lease-state classification hardening. All final evidence must be bound to the final RC.26 archive; an earlier intermediate archive was built before the quarantine follow-up and is not the release candidate. The fresh read-only preflight for the intermediate candidate returned `BLOCKED`, `canActivateNow=false`, exit 3, and no live mutation.

## Candidate and rollback

- Final candidate path: `dist/runalith-1.0.9-rc.26-executing-state-reconciliation-final2-20261028.mcpb`.
- Versioned entry point: `server/index-v1.0.9-rc.26.js`.
- Candidate SHA-256: `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- Candidate size / inventory: 856,171 bytes; 93 unique entries; 74 manifest tools / 74 runtime tools.
- Source snapshot SHA-256: `033f7220b3829db988e82ce68ee00ff98dafca872b45a99e2fc155e9bc276621`.
- Source alignment: `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`; report `/tmp/runalith-source-alignment-rc26-executing-state-reconciliation-final2-20261028.json`, SHA-256 `d2b26234fcaae237724a107e6506579293274acada82ac1f452b33fb9e66b0ed`.
- Rollback candidate: `dist/runalith-1.0.9-rc.25-runtime-trust-ledger-and-evidence-integrity-20261028.mcpb`.
- RC.25 rollback SHA-256: `84d8ddf1fe3c55ad0d1e47a91e3fa11c7267209ffc48cc162f3e915ea03b017e`.
- Earlier RC.26 local archives are preserved. The first intermediate digest was `abdeca7abac0790363ac6982f8a1572f9daf240210ab98ef2e8b1b7d0e22d398`; the `final` archive digest `cf09a8de63d9e1952d1e7a67d075433a8291a70104a822e84439d2a48cd0bb33` predates the added test that places the quarantine row outside five newer lease rows. Both are superseded by final2 above.

## Code and diagnostic changes

1. Reconciliation and rollout now use case-insensitive durable job state checks for `EXECUTING`. Status metadata cannot hide a job that is still counted by the rollout drain gate.
2. Inactive/stale status on an `EXECUTING` job produces `EXECUTING_STATE_STATUS_INCONSISTENT`, classified as `HOLD` with no authorization. No automatic lifecycle transition is proposed.
3. Read-only reconciliation detects `REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION` failed lease rows and `task.lease.quarantined` events even when a lease is outside the recent-history window.
4. Rollout counts only durable `ACTIVE` lease rows as active leases. Quarantine is separately reported as `QUARANTINED_TASK_LEASES_MUST_RECONCILE`; it is not treated as a live lease, but it blocks until authorized provider/owner reconciliation establishes the remote outcome.
5. The external checkpoint bridge documentation is corrected. `--advance-external-checkpoint` is a security-state transition, not a diagnostic. It can commit before final evaluation of other rollout gates; only an authorized, pre-reviewed transition for the exact candidate/rollback binding may invoke it.

## Validation state

After the final source edits, the following targeted suites pass:

- Reconciliation: 11/11.
- Reconciliation v2: 16/16.
- Rollout gate: 17/17.
- Benchmark v68: 15/15.

The final bundle passed exact source-byte alignment, archive/runtime smoke, 74/74 tool schemas, extracted trust/reconciliation/isolated E2E checks and archive integrity.

- `npm test`: PASS, exit code 0; log SHA-256 `1e961284f05e0f6f3d5c554923d5b33c25d1068a0a61d73567bdd10153dc584a`.
- `npm run test:package-reproducibility`: PASS, exit code 0; log SHA-256 `f7b1724c1cb6e142549b2ec433df83c7793c856bfb8852dd9305226b0b83b180`.
- `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.26-executing-state-reconciliation-final2-20261028.mcpb`: `MCPB_FAST_TEST=PASS`, exact candidate SHA-256, 93 entries, 74/74 tools.
- `unzip -t` on the final archive: PASS, no compressed-data errors.
- `npm run docs:check` and `npm run docs:check:external`: PASS; 119 Markdown files, 336 local links and 31 unique external URLs; 74 tool reference entries.
- Static site build and `npm run site:check`: PASS; version `1.0.9-rc.26`, matching entrypoint and RC.26 acceptance file.
- `git diff --check`: PASS.

## Live blockers from the current read-only preflight

The final2-candidate report is `/tmp/runalith-preflight-rc26-final2-20261028.json`, generated `2026-10-28T07:09:00.165Z`, SHA-256 `5e20b87ffb51dfe8f8aac530d78087834eda82604272d4a83fdfdc395dfc0789`. It reports `BLOCKED`, `canActivateNow=false`, `readOnly=true`, `liveMutationPerformed=false`, `externalSecurityStoreMutationPerformed=false`, and `externalCheckpointTransition=NOT_REQUESTED` (exit code 3, as expected for a blocked preflight).

Unresolved gates:

- `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — obtain the exact owner-signed 71-path manifest and builder receipt from the Phase 2 contract authority. Do not infer the 71-path set from the 93-entry archive or weaken the contract.
- `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — obtain trusted builder provenance, independent verification and release approval bound to the exact candidate, installed baseline, rollback and host-issued nonce.
- `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — the host/security administrator must provide and verify both versioned, independently administered verifier/reviewer trust configs and effective runtime ledger history.
- `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — the host/security authority must provision the adapter, trust policy, independently protected monotonic store and signed nonce-bound continuity/CAS receipts.
- `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — workflow owners/providers must reconcile each executing job against event, attempt, result, artifact, owner, provider, runtime and lease lineage.
- `RUNNING_TASKS_MUST_DRAIN` — task owners/providers must resolve each running task using authoritative runtime/provider and durable result/completion evidence.

Final2 read-only reconciliation: `/tmp/runalith-live-reconcile-rc26-final2-20261028.json`, generated `2026-10-28T07:08:56.873Z`, SHA-256 `a102c97b2eb62a4b4566958d281c192dc06dcd240ceaaf79961e3761a51e5937`. It observes 137 jobs, 1,277 tasks, 5,308 events, 908 results, 867 artifacts, 982 attempts, 119 approvals, zero task-lease rows, 85 selected jobs without truncation, 60 jobs flagged for reconciliation and 61 running tasks associated with 60 jobs without active leases. Missing leases do not prove a worker is dead.

## Operational constraints

- Keep the current branch; do not create a new branch or pull request.
- Do not overwrite RC.25, benchmark v67 or prior immutable evidence.
- Do not fake keys, signatures, release approvals, checkpoint receipts or owner/provider confirmations.
- Do not reset, retry, cancel, terminalize, kill or redispatch live jobs/tasks from diagnostic output alone.
- Do not request external checkpoint advancement until all other gates are independently verified and the checkpoint authority explicitly approves the exact state transition.

**Rollout status: `BLOCKED`.** A code fix can improve detection and keep safety gates consistent; it cannot provide the authority-owned inputs required for production activation.
