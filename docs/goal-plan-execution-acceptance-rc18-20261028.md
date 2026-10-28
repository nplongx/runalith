# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.18 (2026-10-28)

## Decision

**Local end-to-end: PASS. Candidate byte alignment: PASS. Live verified proposal: BLOCKED. Production dispatch: NOT RUN / NOT AUTHORIZED. Rollout: BLOCKED.**

RC.18 carries the updated integration test through the versioned JSON trust-configuration path that the MCPB manifest exposes. The runtime implementation file is byte-identical to RC.17; this candidate does not introduce a new production runtime behavior and has not been installed or activated. The host remains on RC.17, so no reinstall is needed for runtime-code parity.

## Candidate and source alignment

- Candidate: `dist/runalith-1.0.9-rc.18-json-trust-e2e-20261028.mcpb`
- SHA-256: `6d3f10cb19ccb1fc5ce77b3881481f8511e4fa4eb95645a9c3302e101d738d4b`
- Size: 844,544 bytes; 93 archive entries; 74 manifest/runtime tools.
- RC.18 entry point is a byte-for-byte copy of the RC.17 runtime source; the manifest and package metadata select the RC.18 path/version.
- Source snapshot SHA-256: `c76cf22a38dd4f4be37d7ecd05feff7a38af99299740d093ff5a7821645dc23a`.
- Source-alignment report: `/tmp/runalith-source-alignment-rc18-final2-20261028.json`.
- Source-alignment report SHA-256: `18b766b0115ed9125f86c759896e14820cebed5c83a12290b90a4d0ddf5cd5d4`.
- `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`; 92 archive entries match exact source bytes and one package metadata entry matches the documented projection. ZIP integrity and extracted runtime smoke pass.
- Source provenance remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; release eligibility remains `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`. The archive digest is verified locally, not authenticated publisher provenance.

## Integration verification

The full `npm test` run passed. Log: `/tmp/runalith-npm-test-rc18-json-trust-e2e-final2-20261028.log`; SHA-256 `249c9268850fbed2d03a2a992e424e34402325045b0058d9dcbd535c308c7fbd`.

`npm run test:package-reproducibility` passed. `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.18-json-trust-e2e-20261028.mcpb` returned `MCPB_FAST_TEST=PASS` with 93 archive entries, 74/74 tools and an isolated database. ZIP integrity reports no errors. Documentation checks pass for 103 Markdown files / 334 local links; the static-site check reports RC.18, 74 tools and the RC.18 entry point. `git diff --check` passes.

The actual isolated MCP E2E uses only a disposable SQLite database and disposable test keys. It now sets `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` using the RC.17/RC.18 versioned schema, with no legacy-key fallback. It explicitly asserts both trust domains are configured, provider IDs differ, canonical SPKI fingerprints are disjoint, and each projected Plan Graph step carries durable `artifact://` evidence references.

The test completed this chain:

1. Nine actual isolated producer tasks completed through the workflow API and emitted typed artifacts.
2. Each artifact was checked against exact content bytes, successful result, completed attempt, canonical artifact-created event and task-completion event.
3. Eleven Goal/Idea nodes and 22 edges were persisted in the isolated graph store. The exact current snapshot and evidence manifest were signed with a disposable test verifier and re-read through the verifier.
4. Verified graph search projected a nine-step Plan Graph; all nine steps retained durable supporting evidence, and the source DAG dependencies remained intact.
5. Compatibility and readiness were checked separately; the test covers missing evidence, invalid artifact bytes/schema/lineage, unregistered evidence and dependency inversion.
6. A review-only Plan Graph proposal and Execution Graph proposal were persisted and read back. The Execution Graph is bound to the exact immutable plan, and reviewer identity/approval is tested separately.
7. The controlled lifecycle was exercised only in the disposable database. The test explicitly leaves `productionAuthorityGranted=false`.

Negative coverage also includes invalid signature/scope, nonce replay, stale snapshot, provenance tampering, trust-root collision, rotation/revocation, anti-rollback, expired reviewer proof, artifact alteration after approval and failed dispatch preconditions. The local PASS is not a live proposal or production-dispatch PASS.

## Live host identity — read-only checks

The live `orchestrator_health` response reports version `1.0.9-rc.17`, entry point `server/index-v1.0.9-rc.17.js`, entry-point SHA-256 `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`, and manifest SHA-256 `e3e0577b26f109da5ba02519e987df8fbc4a7310a58299e2f16d5bb1ed2d5b9f`. The reported hash semantics are startup file hashes only, not a package digest or signed provenance.

`verify-installed --candidate dist/runalith-1.0.9-rc.17-final2-candidate-20261028.mcpb` returned `FILES_MATCH_EXACTLY`, compared 93 files, and reported no mismatches. The active generation is `/home/long/.config/chat-on-steroids/plugins/45fab1a1-6da8-4ccc-a452-86169ca6af5c/g-esUTMD`, PID `183213`, parent host `/opt/Chat On Steroids/chat-on-steroids`. The host does not expose an authenticated digest of the stored MCPB container; only installed-file parity is established.

### Effective trust configuration

`adaptive_goal_trust_configuration_status` remains `blocked`:

- `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` is blank → `KNOWLEDGE_VERIFIER_NOT_CONFIGURED`.
- `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` is blank → `AGG_TRUST_CONFIG_NOT_CONFIGURED`.
- Neither domain has a provider ID, trust-root fingerprint or configured public roots.

The isolated test keys are disposable and are not candidate production trust roots. Do not copy them into the live host.

### Persisted Goal/Idea Graph and proposal state

Read-only `adaptive_goal_knowledge_snapshot_get` results:

| Goal | Snapshot hash | Nodes / edges | Evidence refs / manifest | Result |
|---|---|---:|---:|---|
| `runalith-agg-e2e-20261026-clean` | `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3` | 7 / 7 | 0 / 0 | `KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY`, `eligibleForAttestation=false` |
| `runalith-agg-e2e-20261026` | `29ea64bf28986049fd195a2de76d8e122a0798bb49cb7e97c9bf1c5f65468ce7` | 8 / 9 | 0 / 0 | `KNOWLEDGE_ACTION_EVIDENCE_MISSING`, `eligibleForAttestation=false` |

The latest read-only reconciliation `/tmp/runalith-live-reconcile-rc17-json-e2e-20261028.json` has SHA-256 `5343b80f7c4372062b7a3cb5a20db2a18c26403d48fdf52700f5ab97a2cb6020`. It considered 85 jobs: 7 awaiting dispatch, 18 awaiting proposal/approval, and 60 requiring owner/runtime reconciliation. A read-only SQL count found 61 running tasks across 60 jobs and zero active task leases. The workflow DB contains 137 jobs, 1,277 tasks, 5,308 events, 867 artifacts, 982 attempts, 908 results and 119 approvals. Missing lease does not prove a worker is dead.

The persisted proposal audit still finds three Plan Graph proposals with 22 observed steps missing `supportingEvidenceRefs`, three proposals without authenticated current snapshot binding/signature revalidation, and zero persisted Execution Graph proposals. Four historical planner source-evidence rows fail current source-hash validation. None of these records was rewritten or promoted.

## Rollout preflight

The read-only preflight used the RC.18 candidate and exact RC.17 candidate as rollback baseline:

- Report: `/tmp/runalith-preflight-rc18-json-trust-e2e-20261028.json`.
- SHA-256: `e90f82956abbe9eca2fd4c3f744283fe765beb0a9cabfa5661ee83331a9661c7`.
- `status=BLOCKED`, `canActivateNow=false`, `readOnly=true`.
- `liveMutationPerformed=false`, `externalSecurityStoreMutationPerformed=false`, checkpoint transition `NOT_REQUESTED`.

The six blockers are:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — authentic owner-signed canonical 71-path manifest and builder-signed receipt are missing.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — signed SLSA provenance, independent verification envelope and release approval bound to candidate/baseline/rollback are missing.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — both independently administered versioned JSON trust documents and effective runtime verification are missing.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — host-owned authenticated checkpoint adapter, protected monotonic store, fresh signed attestation and CAS receipt are missing.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — 60 job records need owner/provider/runtime reconciliation.
6. `RUNNING_TASKS_MUST_DRAIN` — 61 running tasks need record-level runtime/lease/attempt/result/completion/artifact reconciliation.

## Required next operational actions

1. Obtain the two actual public-only trust JSON documents from their independently administered verifier and reviewer authorities. Validate the pair offline with `scripts/validate-agg-trust-config.mjs`; provision them only through the host-supported configuration mechanism, then verify effective runtime status. Do not generate substitute trust roots.
2. Start a fresh, authorized producer workflow in a separate approved scope. Build a new Goal/Idea graph only from its real durable `artifact://` outputs and current producer/result/attempt/completion lineage. Do not retrofit evidence onto the two diagnostic graphs or reuse stale artifacts from unrelated jobs.
3. Have the trusted verifier adjudicate the claims/independence and sign the exact new snapshot and evidence-manifest hash. Re-read the signed snapshot, create/read back the Plan Graph, verify all nine-or-required steps' `supportingEvidenceRefs`, then create/read back the Execution Graph against the exact immutable Plan Graph.
4. Require the separately trusted reviewer identity and approval for the exact candidate/plan. Dispatch only through the normal controlled lifecycle after every readiness, release, checkpoint and active-job/task gate passes.
5. Reconcile every executing job and running task individually against authoritative owner/runtime/provider status and event/attempt/result/artifact lineage. Do not bulk-reset, terminalize, cancel, retry or redispatch based on age or missing lease alone.

No live workflow DB writes, graph mutation, host configuration edits, runtime restart, package activation, external checkpoint transition or production dispatch occurred in this work session.
