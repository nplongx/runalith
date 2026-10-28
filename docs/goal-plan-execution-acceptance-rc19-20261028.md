# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.19 (2026-10-28)

## Decision

**Isolated end-to-end integration: PASS. Read-only live evidence assessment: PASS. Source-to-bundle byte alignment: PASS. Live verified proposal: BLOCKED. Production dispatch: NOT RUN / NOT AUTHORIZED. Rollout: BLOCKED.**

RC.19 is a real diagnostic/acceptance successor to RC.18. It makes the read-only Goal/Idea reconciliation report distinguish graph structure from evidence-material eligibility and reports per-reference current byte/producer-lineage results. It does not add evidence to historical graph records, change workflow lifecycle, or establish signature/production authority. The versioned server entrypoint is byte-identical to RC.18; runtime dispatch behavior did not change.

## Candidate and build evidence

- Candidate: `dist/runalith-1.0.9-rc.19-evidence-eligibility-20261028.mcpb`
- SHA-256: `d555e5c7e5665cbf584adce6b98c0320ad060695f5e968697a4c5df9bda64050`
- Size: 846,471 bytes; 93 archive entries; 74 manifest tools / 74 runtime tools.
- RC.19 entrypoint: `server/index-v1.0.9-rc.19.js`, SHA-256 `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1` (byte-identical to RC.18/RC.17 entrypoint).
- Source snapshot SHA-256: `8cafba2c7990e0fa8e41cb88520bb6d0744d6904b22c92d32ff64b40b7915086`.
- Source-alignment report: `/tmp/runalith-source-alignment-rc19-evidence-eligibility-20261028.json`, SHA-256 `a54943d035878cdf9974562e5ad392e87cac4329446f855ae9ec492339eca347`.
- Result: `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`; 92 exact source-byte matches plus one documented generated package-metadata projection; ZIP integrity and extracted runtime smoke passed.
- Package reproducibility: `npm run test:package-reproducibility` exited 0.
- MCP fast candidate test: `MCPB_FAST_TEST=PASS`; isolated SQLite database, 93 archive entries, 74/74 tools.
- Full extracted-package build checks passed, including tool schema validation, read-only reconciliation tests, Goal/Idea → Plan → Execution E2E and local MCP lifecycle tests.
- Full `npm test` exited 0. Log: `/tmp/runalith-npm-test-rc19-evidence-eligibility-20261028-final.log`, SHA-256 `77e5846fc311253f63a9739f2c140f9578443a7c3fb668d4ec0071df8f2ef6ce`.
- Benchmark successor fixture: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v61.json`, SHA-256 `d008e8576de48aeeabc8eace7dd90e32c057252b07bd2ac8923c22ed7a30366e`. It supersedes v60; v60 and earlier fixture bytes remain unchanged. v61 pins the updated package, manifest, benchmark runner, reconciliation implementation, reconciliation regression test and runbook.

Source alignment is not authenticated publisher provenance. The source tree is dirty, no authenticated builder receipt or independent release approval was supplied, and release eligibility remains blocked. A locally calculated SHA-256 proves local bytes, not who built or approved them.

## Implementation change in RC.19

`scripts/reconcile-active-workflows.mjs` now reports `adaptiveGoalGraph.goals[].evidenceAssessment` separately from `graphIntegrity`:

- Declared/assessed evidence-reference counts and artifact/source reference counts.
- Per-reference `artifact://` content/schema/producer/task/result/attempt/completion/artifact-created-event lineage revalidation against current durable records.
- Per-reference content-addressed `file:` byte-hash validation against the current repository.
- Fail-closed blockers for empty manifests, unsupported/unresolved references, invalid artifact lineage, incomplete inventories, action nodes without durable artifact evidence, and evidence nodes without source references.
- Explicit `claimTruthVerified=false`, `independenceVerified=false`, and `cryptographicSignatureVerificationAttempted=false`.

`EVIDENCE_MATERIAL_ELIGIBLE_FOR_EXTERNAL_ATTESTATION` means only that the locally observable bytes and lineage passed these checks. It does not authenticate a verifier, prove a claim true, prove evidence independence, or grant planning/dispatch authority. A current trusted signature over the exact snapshot and evidence-manifest hash is still required.

Regression tests pass for empty manifests, missing/unresolved artifact evidence, action-node evidence requirements, content-addressed source bytes, current durable lineage, stale source hashes, artifact-byte tampering, completion-event substitution, proposal evidence gaps, dependency DAG inversion, and non-authorizing snapshot/signature diagnostics.

## Live read-only reconciliation

Report: `/tmp/runalith-live-reconcile-rc19-evidence-eligibility-20261028.json`.

SHA-256: `04792b7385391fae484cb9b4f8533399dd60fa51ce22a98e7cd214c5089d9a5b`.

Generated `2026-10-28T04:01:47.539Z` against `/home/long/.chat-on-steroids/agent-orchestrator/workflow.db`. The command opened SQLite read-only and wrote only a new exclusive diagnostic report.

### Goal/Idea Graphs

| Goal | Current snapshot hash | Nodes / edges | Evidence refs | Assessment |
|---|---|---:|---:|---|
| `runalith-agg-e2e-20261026` | `29ea64bf28986049fd195a2de76d8e122a0798bb49cb7e97c9bf1c5f65468ce7` | 8 / 9 | 0 | `BLOCKED`: `KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY`, `KNOWLEDGE_ACTION_EVIDENCE_MISSING` |
| `runalith-agg-e2e-20261026-clean` | `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3` | 7 / 7 | 0 | `BLOCKED`: `KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY` |

Both graphs remain structurally well-formed, but both have zero evidence references and zero attestations. No evidence was attached and no graph was mutated. Four historical planner source-evidence rows still fail current source-hash validation; they remain invalid and must not be repaired by changing recorded hashes.

### Plan Graph / Execution Graph

- Three persisted Plan Graph proposals; 22 total steps; all 22 steps lack `supportingEvidenceRefs`.
- All three proposals lack authenticated current-snapshot binding/signature revalidation and independent source revalidation.
- Zero persisted Execution Graph proposals and zero execution-plan-candidate-created events were observed.
- Fingerprint consistency and internal binding checks are diagnostic only. Existing proposal state, including a stored workflow state of `APPROVED`, does not establish current evidence readiness, reviewer authority, immutable-plan pin validity or dispatch permission.

### Workflow/job/task reconciliation

The database contains 137 jobs, 1,277 tasks, 5,308 events, 867 artifacts, 982 attempts, 908 results, 119 approvals and zero active `task_leases` rows. The bounded report considers 85 jobs: 7 awaiting dispatch, 18 awaiting proposal/approval, and 60 requiring owner/runtime reconciliation. The read-only task inventory shows 61 running tasks across 60 jobs. A missing lease is not proof that a worker is dead. Each job and running task must be reconciled individually against event, attempt, result, artifact lineage, owner, provider, runtime/process identity and authoritative lease state.

## Rollout preflight

Preflight report: `/tmp/runalith-preflight-rc19-evidence-eligibility-20261028.json`.

SHA-256: `9f0e97a2389edde57cfffc65918bdab5b5ae28220be2b00443ba8856d43f2daf`.

The preflight exited with code `3` (`BLOCKED`), `canActivateNow=false`, `readOnly=true`, `liveMutationPerformed=false`, and checkpoint transition `NOT_REQUESTED`. The six unresolved blockers are:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — the canonical owner-signed 71-path manifest, pinned host trust policy and builder-signed receipt for the exact candidate/source snapshot are absent. RC.19 has 93 archive entries; do not trim it or infer an authoritative path list from the count.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — missing actual signed SLSA provenance, independent verification envelope and release approval bound to exact candidate, installed baseline and rollback bytes.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — both independently administered versioned public-only JSON trust configs and effective host runtime verification are absent.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — missing host-owned authenticated adapter, independently protected monotonic store, fresh signed store attestation and nonce-consuming compare-and-swap commit receipt.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — 60 jobs require owner/provider/runtime reconciliation.
6. `RUNNING_TASKS_MUST_DRAIN` — 61 running tasks require record-level reconciliation and authoritative lifecycle disposition.

## Authority-owned inputs and closure criteria

- **Phase 2 contract owner / controlled builder:** supply the signed canonical manifest containing exactly 71 sorted unique portable paths and a builder-signed receipt bound to this exact candidate SHA-256, manifest digest, canonical source commit/tree/snapshot, archive inventory and every path/content byte. Platform security must provision and authenticate distinct manifest-authority and builder roots in the root-owned `/etc/runalith/phase2-custody-trust.json` policy. The 93-entry candidate is not eligible by count alone.
- **Release authority / independent verifier:** supply signed DSSE/SLSA provenance, an independent verification envelope and a release approval bound to candidate, source, installed baseline and rollback digests, using a fresh host-issued one-time nonce and the host-pinned release policy. The local verifier must cryptographically verify the exact supplied bytes; only the host authority can establish release eligibility.
- **Verifier and reviewer authorities:** supply two versioned JSON trust documents for domains `goal_idea_verifier` / `agg.goal_idea_graph.verify` and `action_intent_reviewer` / `agg.action_intent.review`. Provider IDs must differ and canonical Ed25519 SPKI roots must be disjoint. The host administrator provisions public keys only through the MCPB user-config mechanism and verifies effective runtime status and anti-rollback ledger. Test keys must never be reused.
- **Platform security / external checkpoint authority:** provision `/etc/runalith/external-checkpoint-trust.json`, the fixed host-owned `/usr/local/libexec/runalith/external-checkpoint-adapter`, distinct checkpoint/store-attestation roots and an independently protected monotonic store. Verify fresh signed continuity, nonce consumption, high-water compare-and-swap, and the authority-signed commit receipt. Local SQLite or a caller callback alone is insufficient.
- **Workflow owners and host/provider operators:** for every executing job and running task, re-query exact job/task/attempt/result/artifact/event/lease records, establish the owner/provider/runtime/process identity, verify attempt fencing and completion order, and record the approved lifecycle disposition through the normal workflow interface. Do not bulk-reset, terminalize, retry, approve, dispatch, release leases or kill processes based on age or absent lease rows.

Operational command contracts and recovery steps are in `docs/agg-production-trust-provisioning-runbook.md` and the rollout implementation in `scripts/runalith-rollout.mjs`. All unresolved inputs remain authority-owned; this work did not fabricate them.

## Safety boundary

No live workflow database write, Goal/Idea graph mutation, host config/registry edit, host process restart/kill, package activation, external checkpoint transition or production dispatch occurred. RC.19 is a test/diagnostic candidate only and must remain inactive until all six blockers are independently closed.
