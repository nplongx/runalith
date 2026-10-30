# Runalith RC.41 rollout and acceptance dossier

**Decision: `BLOCKED`. Do not install or activate.** This dossier records local engineering evidence, not independent release authority.

## Candidate and rollback

- Candidate: `dist/runalith-1.0.9-rc.41-integrated-final-20261029.mcpb`.
- Candidate version: `1.0.9-rc.41`.
- Candidate SHA-256: `8684deebea334210ab6f23a3a4d47cad1b79fef2ed994ee64b5565776645c799` (927,245 bytes; 102 archive entries; 74 manifest/runtime tools).
- Source snapshot SHA-256: `a15aeb0503eb6f4c27375167e7d35e57247036d0ffdbf603957fb353bef3c279`.
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- Source alignment report: `artifacts/adaptive-goal-graph/source-alignment-rc41-final-20261029T020500Z.json`, SHA-256 `1bec8dfba0d0276a1a7dcfcbccc31819816d119ed455ace92103814da8026f74`. Result: exact archive/source byte alignment; `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`.
- Read-only rollout preflight: `artifacts/adaptive-goal-graph/rollout-preflight-rc41-final-20261029T020357Z.json`, SHA-256 `921092bab2a5057cc81e2f5093e75e87e55052a06fe5603e46cb93ec691b702e`. Exit `3`, `BLOCKED`, `canActivateNow=false`; no live or external security-store mutation and no checkpoint transition.
- Fresh read-only host trust presence observation: `artifacts/adaptive-goal-graph/live-trust-status-rc41-current-20261029T020437Z.json`, SHA-256 `615c678a5076ddcb8e8f1da86265b8a1524b3d2e05c03ff3f204a968f5abdd9c`. At `2026-10-29T02:04:37Z`, PID `11598` served RC.26. Both trust JSON variables were present but empty; both provider IDs and legacy public roots were absent. This process-environment observation does not authenticate roots or re-verify the external checkpoint.
- Serving host's last directly observed runtime: RC.26. No install, activation, restart, or kill performed.
- Source provenance: dirty working-tree bytes can be checked for exact archive alignment, but no authenticated independent builder receipt exists. Local hashes, tests, and reproducible builds are not release authorization.

## Integrated engineering

- Provider dispatch claim now rechecks durable parent Job and live Task under SQLite claim semantics; terminalization defers when a one-way claim/provider outcome remains unresolved.
- Stale-attempt reconciliation preserves attempts while active leases, live execution sessions, or unresolved provider outcomes may still own execution. Missing lease is not proof of worker death.
- Effective-host trust diagnostics distinguish absent environment variables from present-but-empty values without exposing key material or adding fallback.
- Provider pre-send race regression is included in the packaged mandatory validation list; package entrypoint/version/manifest launch arguments are pinned together.
- CodeGraph index refreshed after lifecycle edits; callers for `reconcileStaleAttempts`, `terminalizeJob`, `failWorkflowVerification`, and `_assertActiveDispatchLease` reviewed.

## Validation boundary

Focused lifecycle/trust regression suite passed 18/18. Full `npm test` passed in `/tmp/runalith-npm-test-rc41-final3-20261029.log`. Package no-overwrite passed in `/tmp/runalith-no-overwrite-rc41-final-20261029.log`; two independent package builds were byte-identical in `/tmp/runalith-repro-rc41-final-20261029.log`. Final packaging smoke and extracted-archive acceptance passed, including 74/74 MCP tools and the packaged lifecycle/trust regressions. `npm run docs:check` passed (140 Markdown files, 357 local links); `npm run docs:check:external` passed 42 URLs, with one HTTP 429 warning for the Argo Workflows documentation site. ZIP integrity passed. These local checks do not establish independent release authority.

## Six open release blockers

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — requires owner-signed canonical sorted 71-path manifest and host-provisioned verifier policy bound to exact candidate/source tree. Do not infer path list from count or trim archive locally.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — requires controlled independent builder's signed provenance for exact candidate bytes, independently verified attestation, exact release approval, and host-issued nonce. Local build/test/hash evidence is insufficient.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — host/security authority must provision and independently verify both effective trust configurations, distinct provider identities, disjoint Ed25519 SPKI roots, scopes, versions, validity, and revocation state. Last observed host had both JSON config values blank; no trust fallback is permitted.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — requires authenticated host adapter/key authority and independently protected signed monotonic checkpoint with nonce, high-water continuity, exact candidate/rollback binding, and independent verification.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — requires workflow-owner/provider/runtime reconciliation and authorized disposition for every active workflow. Do not mutate live records from diagnostics.
6. `RUNNING_TASKS_MUST_DRAIN` — requires authoritative owner reconciliation for 61 observed running tasks without active lease rows. Missing lease does not prove worker death; preserve `HOLD`.

Related unresolved graph evidence: 22 Plan Graph steps lack support evidence; three proposals lack authenticated current-snapshot bindings; zero persisted Execution Graph proposals were observed; four historical planner source-hash mismatch records remain untouched. Do not fabricate evidence or rewrite history. The 86 job records, including 60 outcomes needing verification, require record-by-record authority-backed disposition; do not terminalize or repair them in bulk.

## Operator decision

Run fresh read-only reconciliation, effective-host trust observation, and machine-readable preflight against the final exact candidate and RC.26 rollback. Preflight exit code `3` with `BLOCKED` is expected until the six gates are closed by their respective authorities. Never run `--advance-external-checkpoint` without separate explicit security authorization. Do not dispatch real providers/workflows or change host trust state as part of this engineering task.
