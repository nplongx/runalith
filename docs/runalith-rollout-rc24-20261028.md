# Runalith RC.24 rollout dossier — 2026-10-28

## Decision

**BLOCKED — do not activate or dispatch production workflows.** RC.24 fixes a verified entrypoint identity inconsistency: `npm start` pointed to RC.21 while package `main`, `runtimeEntryPoint`, and the MCP manifest pointed to RC.23. The successor makes these values identical and tests the contract. Runtime entrypoint bytes are unchanged from RC.23.

## Candidate and validation

- Candidate: `dist/runalith-1.0.9-rc.24-runtime-entrypoint-consistency-20261028.mcpb`.
- Package version: `1.0.9-rc.24`; entrypoint `server/index-v1.0.9-rc.24.js`.
- Benchmark successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v66.json`; v65 and earlier fixtures remain unchanged.
- Archive SHA-256 `125d785b897dee1b6758c8f6d3508c7930d2a87f357d1b953616e7043fb596c8`; 852,448 bytes; 93 entries; 74 tools.
- Source snapshot SHA-256 `8a2b11a05f205bb7d93e6bb2a945aee516c2b87224cbf9f892e01d55d72b4c58`; source alignment PASS in `/tmp/runalith-source-alignment-rc24-runtime-entrypoint-consistency-20261028-report.json` (SHA-256 `e2a65a3b36437cf5f8fbb2394017f430dc333330047133f9dba0cd600e7a46cf`). This is not an authenticated builder receipt.
- Full `npm test`: exit 0; log SHA-256 `766787e5968fbfd84cc0f35ee7f2bd940d5f8f7b0967157ee6d6b42aa9b86dab`. `npm run test:runalith-rollout`: PASS, 16/16, including mismatch rejection. Package reproducibility PASS, MCP fast test PASS (74/74), ZIP integrity PASS, docs/site checks PASS, `git diff --check` PASS.
- Fresh reconciliation `/tmp/runalith-live-reconcile-rc24-sensitive-20261028.json`, SHA-256 `48040e3d001a6323672d1eb46236e1a576a0ba7b8ccd4d4660f642d03dc7f250`, mode `0600`. Final preflight `/tmp/runalith-preflight-rc24-runtime-entrypoint-consistency-20261028-v2.json`, SHA-256 `03dfcfcf40845efc966afd1a3274634cd4a9d4d1d1e90eeb7e021f75a9db6ff6`; exit `3`, `BLOCKED`, `canActivateNow=false`, read-only, no checkpoint transition.
- Benchmark v66 SHA-256 `c300d1c2d79c1ec40a02d0a312547ec39fb77bb6f3d3aee5b90fd0e479f3ae7c`; v65 SHA-256 `40acdf4ac7cb4ab9b403b53702ee0e79744ec5bdc4b9b095ced85445bae4a19c` remains immutable.

## Host authority gates

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — owner-signed canonical 71-path manifest; exact candidate/source/tree builder receipt; host-pinned, distinct authority and builder keys.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independent DSSE/SLSA provenance, verification envelope, approval bound to candidate/baseline/rollback, and host-issued nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — separate verifier/reviewer administrators and versioned public-only JSON configs; distinct provider IDs and disjoint Ed25519 SPKI roots/scopes; effective host config and anti-rollback evidence.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — host-owned authenticated checkpoint adapter, independent monotonic store, signed continuity, nonce consumption and CAS receipt.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — owner/provider/runtime-confirmed disposition for every executing job after full lineage review.
6. `RUNNING_TASKS_MUST_DRAIN` — provider execution state, task lineage and authoritative lease/owner epoch must be checked; missing lease is not proof of death.

The fresh RC.24 report records 137 jobs, 1,277 tasks, 5,308 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and zero lease rows. It flags 60 jobs for reconciliation and 60 jobs with running tasks but no active leases. These counts do not prove worker death. It also reports 63 planner runs / 373 evidence rows, 2 Goal/Idea graphs with empty evidence manifests, 3 Plan Graph proposals / 22 steps missing evidence, 3 proposals without authenticated snapshot binding, and zero persisted Execution Graph proposals. No bulk reset, terminalization, drain, activation, host mutation, DB write, checkpoint advance or production dispatch is authorized by this dossier.
