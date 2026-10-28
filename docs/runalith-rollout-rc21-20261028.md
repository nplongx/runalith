# Runalith RC.21 rollout dossier — 2026-10-28

## Decision

**BLOCKED — do not activate or dispatch production workflows.** RC.21 adds source-action coverage validation to read-only Plan Graph reconciliation. The versioned server entrypoint is byte-identical to RC.20; no runtime behavior changed and no host activation/restart was attempted.

## Candidate

- Path: `dist/runalith-1.0.9-rc.21-actionable-source-coverage-20261028.mcpb`
- SHA-256: `325564a510593810ad670a03e8516a2e56f66d2b95951dbd3df2fc5ceb10f16f`
- Size: 851,182 bytes; 93 archive entries; 74 tools.
- Entrypoint SHA-256: `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`.
- Source snapshot SHA-256: `56cb8d57ca4d0a93c777d1b5cec346c2fb9a7d595f68780ad32e22bf86e67379`.
- Source-alignment report: `/tmp/runalith-source-alignment-rc21-actionable-source-coverage-20261028.json`, SHA-256 `3b728b1714fd584c3ce0314c73152daeae0ea316104cbcfd6c95a32cc1a9a35b`; `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`, 92 exact source matches plus one generated metadata projection. This is not authenticated publisher provenance.
- Full `npm test`: exit 0, log SHA-256 `03d303f8d728ce84f08d6ff5a0615b8ce39fe162c51123d9d92fb7da3dc1ed2f`.
- Benchmark fixture v63 SHA-256: `9012aeca46569d9c8851150cf92f1be9a4903cb97baa0c2895cbf88526874868`; v59–v62 unchanged.

## RC.21-specific change

`scripts/reconcile-active-workflows.mjs` now flags every actionable source node missing from the persisted Plan Graph and refuses to skip an actionable prerequisite edge when either endpoint lacks a step mapping. Codes: `SOURCE_ACTION_NODE_NOT_PROJECTED` and `SOURCE_GRAPH_PREREQUISITE_NOT_PROJECTED`. The regression mutates a persisted Plan proposal by omitting an action node while leaving the rest of the draft intact. This is a diagnostic HOLD, not a repair or authority grant.

## Required final verification artifacts

- Live reconciliation: `/tmp/runalith-live-reconcile-rc21-actionable-source-coverage-20261028.json`, SHA-256 `5d87c6fab7a723bbdf9232429928c9c54895a381fc97f9a6b7d9a8a733e3b058`.
- Preflight: `/tmp/runalith-preflight-rc21-actionable-source-coverage-20261028.json`, SHA-256 `72184224984d016ddfacf2a3a1024bc06ea5229c09303d190ea22118c9ec7b7e`.
- Preflight exited `3` / `BLOCKED`, `canActivateNow=false`, read-only, no live mutation, checkpoint transition `NOT_REQUESTED`. Source provenance still requires an authenticated builder receipt and independent release authority.

The fresh live report observes 60 jobs requiring owner/provider/runtime reconciliation, 61 running tasks, two evidence-ineligible Goal/Idea graphs, 22 Plan Graph steps missing `supportingEvidenceRefs`, three proposals without authenticated current-snapshot binding, four current source-hash mismatches and zero Execution Graph proposals. No lease rows were present; this does not establish worker death.

## Six unresolved gates

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` (brief alias `PHASE2_AUTHORITY_INPUTS_MISSING`): owner-signed canonical 71-path manifest and builder-signed exact-candidate/source receipt; host-pinned disjoint authority/builder roots. Never trim the 93-entry archive.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` (brief alias `RELEASE_PROVENANCE_AND_APPROVAL_MISSING`): independent signed provenance, verification envelope and release approval bound to candidate/baseline/rollback digests and host-issued nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` (brief alias `HOST_MANAGED_TRUST_CONFIG_NOT_PROVISIONED`): independently administered versioned verifier/reviewer JSON trust configs, different provider IDs, disjoint Ed25519 SPKI roots, exact scopes, effective runtime verification and anti-rollback.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` (brief alias `HOST_MANAGED_CHECKPOINT_CONTINUITY_NOT_VERIFIED`): host-owned authenticated adapter, independent monotonic store, signed fresh continuity, nonce consumption and CAS commit receipt.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: per-job event/attempt/result/artifact/owner/provider/runtime/lease reconciliation and owner-authorized disposition.
6. `RUNNING_TASKS_MUST_DRAIN`: per-task completion and artifact lineage, attempt fencing, runtime/provider state and authoritative lease/owner epoch.

The host must not accept test-local signatures, local JSON booleans, a content hash as claim truth, or absence of a lease as proof of worker death. All live lifecycle decisions require the workflow owner and host/provider authority. No live DB write, graph mutation, host config/registry edit, process restart/kill, package activation, external checkpoint transition or production dispatch was performed.
