# Runalith RC.18 rollout dossier — 2026-10-28

## Rollout decision

**BLOCKED — do not activate or dispatch production workflows.** RC.18 packages an updated JSON-trust E2E test and source-aligned candidate. Its runtime entrypoint is byte-identical to RC.17; the live host already has RC.17 installed with exact 93/93 installed-file parity. There is no runtime-code reason to reinstall merely to obtain the updated packaged test.

## Candidate identity

| Item | Verified value |
|---|---|
| Candidate | `dist/runalith-1.0.9-rc.18-json-trust-e2e-20261028.mcpb` |
| SHA-256 | `6d3f10cb19ccb1fc5ce77b3881481f8511e4fa4eb95645a9c3302e101d738d4b` |
| Size / archive entries | 844,544 bytes / 93 |
| Manifest/runtime tools | 74 / 74 |
| Source snapshot SHA-256 | `c76cf22a38dd4f4be37d7ecd05feff7a38af99299740d093ff5a7821645dc23a` |
| Source alignment | `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT` |
| Source-alignment report SHA-256 | `18b766b0115ed9125f86c759896e14820cebed5c83a12290b90a4d0ddf5cd5d4` |
| Full test log SHA-256 | `249c9268850fbed2d03a2a992e424e34402325045b0058d9dcbd535c308c7fbd` |

Source alignment is byte-accurate but reports `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; the candidate is not an authenticated release. The full acceptance evidence and exact live blockers are recorded in [RC.18 acceptance](goal-plan-execution-acceptance-rc18-20261028.md).

## Effective live state

- Host runtime: `1.0.9-rc.17`, active process PID `183213` under the Chat On Steroids host.
- Installed RC.17 candidate file parity: `FILES_MATCH_EXACTLY`, 93 compared files, zero mismatches. The host does not expose an authenticated digest for the stored MCPB container.
- Goal/Idea verifier JSON and action-intent reviewer JSON are both blank. Trust status is blocked; there are no configured provider IDs or trust roots.
- The two existing persisted Goal/Idea graphs are not attestable: the 7-node graph has an empty evidence manifest; the 8-node graph has an experiment without durable `artifact://` evidence. Both have zero verifier attestations.
- Three Plan Graph proposals / 22 steps remain missing `supportingEvidenceRefs`; three proposals lack authenticated current-snapshot/signature validation; no persisted Execution Graph proposal exists.
- Read-only workflow reconciliation found 60 jobs needing owner/runtime reconciliation and 61 running tasks across those jobs, with zero active task leases. No lifecycle changes are authorized by these observations alone.

## Preflight decision

Read-only preflight report: `/tmp/runalith-preflight-rc18-json-trust-e2e-20261028.json`.

SHA-256: `e90f82956abbe9eca2fd4c3f744283fe765beb0a9cabfa5661ee83331a9661c7`.

`status=BLOCKED`, `canActivateNow=false`; six unresolved gates:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
6. `RUNNING_TASKS_MUST_DRAIN`

The preflight performed no live mutation and did not request an external checkpoint transition.

## Safe continuation

1. Validate and provision the real, independently administered verifier/reviewer JSON trust documents through the supported host mechanism; verify the effective process configuration and trust ledger.
2. Generate fresh current evidence in an approved producer workflow. Create a new evidence-backed Goal/Idea graph rather than modifying historical diagnostic nodes or borrowing unrelated stale artifacts.
3. Obtain the independent verifier signature over the exact snapshot and manifest. Re-read it and project a Plan Graph with evidence refs on every step.
4. Create/read back the Execution Graph proposal against the immutable Plan Graph, then obtain a separate trusted reviewer identity/approval for the exact candidate.
5. Close release/checkpoint and record-level job/task reconciliation gates before any production lifecycle transition.

No host registry/config edit, runtime restart, live DB write, graph mutation, package activation, external checkpoint transition or production dispatch was performed. A test-local PASS or shadow `APPROVED` state is not production authority.
