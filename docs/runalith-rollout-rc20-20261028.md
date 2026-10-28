# Runalith RC.20 rollout dossier — 2026-10-28

## Decision

**BLOCKED — do not activate or dispatch production workflows.** RC.20 hardens read-only recovery tooling and fail-closed acceptance tests. It does not change runtime dispatch behavior; the versioned server entrypoint is byte-identical to RC.19. No host install, activation or restart was attempted.

## Exact candidate

- Path: `dist/runalith-1.0.9-rc.20-reconciliation-hardening-20261028.mcpb`
- SHA-256: `f7a3b8235632442e1012d39d1bcd5ec53563708c686ab5e4a0e04a00f09d5e31`
- Size: 850,634 bytes; 93 archive entries; 74 manifest tools / 74 runtime tools.
- Entrypoint: `server/index-v1.0.9-rc.20.js`, SHA-256 `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`.
- Source snapshot SHA-256: `e86b8d3794e319f1daeae050133fdd43cfc444ee7656e76747a6918867659000`.
- Source-alignment report: `/tmp/runalith-source-alignment-rc20-reconciliation-hardening-final-20261028.json`, SHA-256 `04e8af26b17d53d5fc9cc9b5631720ee4f3aa3d6fa06c9e3e45bed98e96383c9`. Result: `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`; exact archive-byte parity passed, 92 source byte matches plus one generated metadata projection. Source provenance remains dirty-tree/local only without an authenticated builder receipt.
- Full `npm test`: exit 0, log `/tmp/runalith-npm-test-rc20-reconciliation-hardening-final.log`, SHA-256 `4bb95356cb7140eaac791597fdffce99bba9b53a9a2ead7a54547a44cc1ddb87`.
- MCPB pack/extracted runtime: PASS; MCP fast test: `MCPB_FAST_TEST=PASS`; package reproducibility and ZIP integrity were checked separately.
- Benchmark fixture successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v62.json`, SHA-256 `9c128ec00d81685f77543174a227a95cafd0dc448b4e55553f5762f3bff74ca2`; v59–v61 files are preserved.

## Current read-only state

- Reconciliation report: `/tmp/runalith-live-reconcile-rc20-reconciliation-hardening-20261028.json`, SHA-256 `c841aff7562392077ba7f87784eabebcbf4b9208c2fbeb319b189dca1e7df58a`.
- Preflight report: `/tmp/runalith-preflight-rc20-reconciliation-hardening-final-20261028.json`, SHA-256 `884cfb077024be64042058d5b1ad0441770bfea925d04deacca6cef6497f43ac`.
- Preflight decision: `BLOCKED`, exit code `3`, `canActivateNow=false`, `readOnly=true`, no live mutation, external checkpoint transition `NOT_REQUESTED`.
- Two Goal/Idea graphs have zero evidence references/empty manifests. Three Plan Graph proposals / 22 steps lack `supportingEvidenceRefs`; three proposals lack authenticated current-snapshot binding. Zero persisted Execution Graph proposals were observed.
- 60 jobs require owner/provider/runtime reconciliation; 61 running tasks across 60 jobs; zero active task leases. Missing leases are not proof of worker death.
- Verifier/reviewer host JSON trust configuration remains unverified; test-only roots were not provisioned.

## Blockers and exact closure conditions

The preflight keeps these compatibility-preserving codes:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` (brief alias `PHASE2_AUTHORITY_INPUTS_MISSING`) — owner-signed canonical 71-path manifest, host-pinned independent manifest/builder trust roots, and builder-signed receipt bound to candidate/source/path bytes are missing. The archive has 93 entries; do not trim it or infer the signed path contract from that count.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` (brief alias `RELEASE_PROVENANCE_AND_APPROVAL_MISSING`) — signed SLSA/DSSE provenance, independent verification envelope and release approval bound to candidate, installed baseline and rollback bytes are missing.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` (brief alias `HOST_MANAGED_TRUST_CONFIG_NOT_PROVISIONED`) — independently administered versioned verifier/reviewer JSON trust configs, distinct provider IDs and disjoint canonical Ed25519 SPKI roots are missing from effective host runtime configuration.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` (brief alias `HOST_MANAGED_CHECKPOINT_CONTINUITY_NOT_VERIFIED`) — host-owned authenticated adapter, independently protected monotonic checkpoint store, fresh signed continuity, nonce-consuming CAS and commit receipt are missing.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — each executing job needs record-level owner/provider/runtime and event/attempt/result/artifact/lease reconciliation plus approved disposition.
6. `RUNNING_TASKS_MUST_DRAIN` — each running task needs exact attempt/result/completion/artifact lineage and authoritative provider/lease state verified.

The full provisioning contract and safe recovery instructions are in [RC.20 acceptance](goal-plan-execution-acceptance-rc20-20261028.md) and `docs/agg-production-trust-provisioning-runbook.md`. All required signatures, public roots, approvals, external checkpoint receipts and lifecycle dispositions must come from their real independent authorities. No test-local evidence may be promoted to production trust.

## Safety record

No live workflow DB write, Goal/Idea graph mutation, host config/registry edit, host process restart/kill, package activation, external checkpoint transition or production dispatch occurred. Keep RC.20 inactive until every gate is independently verified. Do not rewrite historical fixtures/hash values, attach fabricated evidence to old graphs, bulk-reset/terminalize jobs or dispatch tasks to make the preflight pass.
