# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.20

## Decision

**Isolated end-to-end integration: PASS. Read-only live reconciliation: PASS. Source-to-bundle alignment: PASS. Live verified proposal: BLOCKED. Production dispatch: NOT RUN / NOT AUTHORIZED. Rollout: BLOCKED.**

RC.20 is a substantive recovery/reconciliation successor to RC.19. It does not change the server entrypoint behavior; the versioned runtime source is byte-identical to RC.19. Changes are in typed-artifact reconciliation, cross-graph linkage validation, task/lease recovery diagnostics, rollout drain counting and negative E2E coverage.

## Candidate and reproducible evidence

- Candidate: `dist/runalith-1.0.9-rc.20-reconciliation-hardening-20261028.mcpb`
- SHA-256: `f7a3b8235632442e1012d39d1bcd5ec53563708c686ab5e4a0e04a00f09d5e31`
- Size: 850,634 bytes; 93 archive entries; 74 manifest/runtime tools.
- RC.20 entrypoint SHA-256: `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1` (byte-identical to RC.19).
- Source snapshot SHA-256: `e86b8d3794e319f1daeae050133fdd43cfc444ee7656e76747a6918867659000`.
- Source alignment report: `/tmp/runalith-source-alignment-rc20-reconciliation-hardening-final-20261028.json`, SHA-256 `04e8af26b17d53d5fc9cc9b5631720ee4f3aa3d6fa06c9e3e45bed98e96383c9`.
- Benchmark successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v62.json`, SHA-256 `9c128ec00d81685f77543174a227a95cafd0dc448b4e55553f5762f3bff74ca2`; v59–v61 bytes were not edited by this turn.
- Full `npm test`: exit 0. Log: `/tmp/runalith-npm-test-rc20-reconciliation-hardening-final.log`, SHA-256 `4bb95356cb7140eaac791597fdffce99bba9b53a9a2ead7a54547a44cc1ddb87`.
- MCPB pack: source-byte alignment passed; extracted MCP initialize/tools-list passed 74/74; mandatory extracted regressions, trust tests, reconciliation tests and isolated Goal/Idea → Plan → Execution E2E passed.
- `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.20-reconciliation-hardening-20261028.mcpb`: `MCPB_FAST_TEST=PASS`, 93 entries, 74/74 tools, isolated SQLite.
- `npm run test:package-reproducibility`: rerun result is recorded in the terminal validation log for this turn.

Local source-byte alignment and SHA-256 do not authenticate publisher provenance. The source tree remains dirty and there is no authenticated builder receipt or independent release approval. RC.20 is not a production-authorized release.

## Implementation changes

### Typed producer artifact validation

`scripts/reconcile-active-workflows.mjs` now calls the authoritative `artifactSchemaForType()` and `validateArtifactContent()` runtime contract during durable artifact-lineage validation. This rejects an artifact whose bytes and self-reported `content_hash` were both replaced consistently but whose typed content is invalid. The diagnostic reports `PLANNER_EVIDENCE_ARTIFACT_SCHEMA_INVALID` or `PLANNER_EVIDENCE_ARTIFACT_SCHEMA_VERSION_UNSUPPORTED` and keeps the evidence blocked. Artifact-created event, successful result, completed producer task, attempt and completion event lineage are still checked separately.

### Plan → Execution Graph cross-link

The read-only graph report now resolves every persisted Execution Graph proposal's `source_plan_proposal_job_id` to exactly one persisted Plan Graph proposal. It compares the Plan fingerprint, candidate ID, source graph/draft hashes, verification snapshot/attestation bindings, exact unique task-binding coverage of Plan steps, and current Goal/Idea snapshot hash when available. Failures emit `AGG_EXECUTION_GRAPH_SOURCE_PLAN_LINKAGE_INVALID`. These are structural consistency checks only: unkeyed hashes do not authenticate signatures, reviewer identity, approval or dispatch authority.

The isolated E2E suite now forges serialized `source.verification` metadata and recomputes the source-verification hash, proposal fingerprint/ID, proposal hash and wrapper snapshot hashes. Graph readback, candidate readback, approval and dispatch must still fail closed because the runtime rebuilds from the currently trusted source rather than accepting caller-supplied verification labels.

### Workflow recovery and rollout drain checks

- Active leases are queried separately from the five-row recent-lease history window, preventing an older active lease from being mistaken for no lease.
- A truncated attempts/results/artifacts/lease inventory emits `TASK_LINEAGE_INVENTORY_TRUNCATED` and forces `HOLD`.
- Same-job task parent/dependency references and dependency cycles are checked; the report does not repair or rewrite a DAG.
- The rollout gate counts every `state=EXECUTING` job even if its `status` column is inconsistent, and separately blocks on every running task and active lease.
- No report grants lifecycle authority; owner/provider/runtime verification remains mandatory.

## Regression evidence

- `tests/test-reconcile-active-workflows.mjs`: self-hashed schema-invalid artifact, active lease hidden behind newer released rows, truncated history HOLD, missing/self/cyclic task dependencies, dangling Execution Graph source Plan proposal, incomplete cross-graph binding and non-authorizing snapshot diagnostics.
- `tests/test-runalith-rollout.mjs`: an `EXECUTING` job with inconsistent `status='completed'` still counts toward the drain gate.
- `tests/test-adaptive-goal-current-scope-producer-e2e.mjs`: nine real isolated producers, durable typed artifacts, Plan DAG and `supportingEvidenceRefs`, signed current snapshot, persisted Execution Graph proposal, exact immutable plan pin, reviewer identity/approval, controlled lifecycle and tamper/expiry/replay negative paths including recomputed forged verifier metadata.
- `tests/test-adaptive-goal-benchmark.mjs`: v62 pins updated package/entrypoint/reconciliation sources and tests; earlier fixture files are not rewritten.

## Live read-only reports

- Reconciliation: `/tmp/runalith-live-reconcile-rc20-reconciliation-hardening-20261028.json`, SHA-256 `c841aff7562392077ba7f87784eabebcbf4b9208c2fbeb319b189dca1e7df58a`.
- Preflight: `/tmp/runalith-preflight-rc20-reconciliation-hardening-final-20261028.json`, SHA-256 `884cfb077024be64042058d5b1ad0441770bfea925d04deacca6cef6497f43ac`.

Reconciliation still finds two Goal/Idea Graphs with empty evidence manifests, three Plan Graph proposals / 22 steps missing `supportingEvidenceRefs`, three proposals without authenticated current-snapshot binding, zero persisted Execution Graph proposals, 60 jobs needing owner/provider/runtime reconciliation, 61 running tasks and zero active lease rows. The latest report adds per-reference typed schema and lineage checks, cross-graph linkage checks, active-lease coverage and task-DAG findings. Historical source-hash mismatches remain invalid; no evidence was added to historical graph records.

## Six rollout gates and authority-owned inputs

For backward compatibility, preflight continues emitting its existing blocker codes; the first four map to the six gate names in the integration brief as follows:

| Brief gate | Current preflight blocker | Required evidence / authority |
|---|---|---|
| `PHASE2_AUTHORITY_INPUTS_MISSING` | `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` | Contract owner supplies canonical owner-signed manifest of exactly 71 sorted unique portable paths; controlled builder signs receipt bound to exact candidate/source tree and per-path bytes; host security pins distinct authority and builder public roots. Do not trim the 93-entry archive or infer the manifest from entry count. |
| `RELEASE_PROVENANCE_AND_APPROVAL_MISSING` | `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` | Independent release authority supplies signed SLSA/DSSE provenance, verification envelope and release approval bound to candidate, installed baseline and rollback hashes; use host-issued one-time nonce and host-pinned policy. |
| `HOST_MANAGED_TRUST_CONFIG_NOT_PROVISIONED` | `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` | Separate verifier/reviewer administrators supply versioned public-only JSON configs, different provider IDs, disjoint canonical Ed25519 SPKI roots, exact scopes and change records; host admin provisions via supported MCPB user-config and verifies effective runtime state plus anti-rollback ledger. |
| `HOST_MANAGED_CHECKPOINT_CONTINUITY_NOT_VERIFIED` | `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` | Platform security supplies host-owned authenticated adapter, distinct checkpoint/store-attestation roots, independently protected monotonic store, fresh signed continuity observation, nonce consumption and CAS commit receipt. Local SQLite or caller-authored flags are insufficient. |
| `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` | `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` | Workflow owner plus host/provider operators reconcile each job's events, attempts, results, artifacts, runtime/process identity and lease fencing; document owner-authorized disposition. |
| `RUNNING_TASKS_MUST_DRAIN` | `RUNNING_TASKS_MUST_DRAIN` | Reconcile every running task against exact attempt/result/completion/artifact lineage, active lease/owner epoch and authoritative provider state. Missing lease is not proof of worker death. |

No live workflow database write, graph mutation, host config/registry edit, host process restart/kill, package activation, checkpoint transition or production dispatch occurred. Keep rollout `BLOCKED` until all six gates close with independently verifiable evidence.
