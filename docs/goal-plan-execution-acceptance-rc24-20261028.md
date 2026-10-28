# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.24

## Decision

**Local integration acceptance: PASS. Production readiness: BLOCKED.** RC.24 fixes a concrete identity split in `package.json`: `main` and `runtimeEntryPoint` named RC.23, the MCP manifest named RC.23, but `npm start` still launched the RC.21 entrypoint. The versioned successor aligns all four and adds a regression that fails if they diverge. The runtime entrypoint bytes are copied unchanged from RC.23; no dispatch semantics are broadened.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.24-runtime-entrypoint-consistency-20261028.mcpb`
- Version: `1.0.9-rc.24`.
- Entrypoint: `server/index-v1.0.9-rc.24.js`, expected byte-identical to RC.23's `server/index-v1.0.9-rc.23.js`.
- Benchmark successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v66.json`; fixture v65 and all earlier historical fixtures are immutable.
- Archive SHA-256: `125d785b897dee1b6758c8f6d3508c7930d2a87f357d1b953616e7043fb596c8`; 852,448 bytes; 93 archive entries; 74 manifest tools and 74 runtime tools.
- Source snapshot SHA-256: `8a2b11a05f205bb7d93e6bb2a945aee516c2b87224cbf9f892e01d55d72b4c58`.
- Source alignment report: `/tmp/runalith-source-alignment-rc24-runtime-entrypoint-consistency-20261028-report.json`, SHA-256 `e2a65a3b36437cf5f8fbb2394017f430dc333330047133f9dba0cd600e7a46cf`; `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`. Authenticated builder receipt and independent release authority are still NOT VERIFIED.
- Entrypoint `server/index-v1.0.9-rc.24.js` is byte-identical to RC.23; actual extracted package metadata has `main` and `scripts.start` both pointing at the manifest's `server/index-v1.0.9-rc.24.js`.
- Benchmark v66 SHA-256: `c300d1c2d79c1ec40a02d0a312547ec39fb77bb6f3d3aee5b90fd0e479f3ae7c`; v65 SHA-256 `40acdf4ac7cb4ab9b403b53702ee0e79744ec5bdc4b9b095ced85445bae4a19c` preserved.

## Integration and regression coverage

The Goal/Idea → Plan → Execution isolated E2E still exercises typed producer artifacts, durable producer/result/attempt/completion lineage, signed current-snapshot verification, complete nine-node dependency mapping, reviewer identity, immutable plan pinning, and Execution Graph proposal creation. Negative controls continue to reject missing or unregistered evidence, stale source graph, altered artifacts after approval, expired reviewer identity, failed producer/completion, dependency inversion, and replay. Test-only trust roots remain test-only and do not establish production authority.

RC.24 adds a package identity regression requiring `package.json.main`, `package.json.runtimeEntryPoint`, `package.json.scripts.start`, and `plugin/manifest.json.server.entry_point` to resolve to the same versioned entrypoint. Benchmark v66 pins that regression and preserves the frozen graph/oracle and v65 identity.

## Live reconciliation and safe recovery

Fresh read-only reconciliation: `/tmp/runalith-live-reconcile-rc24-sensitive-20261028.json`, SHA-256 `48040e3d001a6323672d1eb46236e1a576a0ba7b8ccd4d4660f642d03dc7f250`, mode `0600`. It currently records 137 jobs, 1,277 tasks, 5,308 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and zero lease rows. Of 85 selected jobs, 60 are flagged for reconciliation; 7 await dispatch and 18 await proposal/approval. There are 63 planner runs / 373 evidence rows, four source-hash mismatch findings across nine rows, two Goal/Idea graphs blocked by empty evidence manifests, three Plan Graph proposals / 22 steps missing `supportingEvidenceRefs`, three proposals without authenticated current-snapshot binding, and zero persisted Execution Graph proposals. These are diagnostic findings, not authority to mutate lifecycle state. The report correlates job/task state with event/attempt/result/artifact/owner/provider/runtime and lease context. A missing lease alone never proves worker death.

For each historical source mismatch, preserve the URI and expected digest; compare observed bytes and claim scope, and ask the claim owner whether the old pin still describes the intended source. Do not rewrite historical rows. Produce new evidence only through the approved producer path after the owner confirms semantic relevance. Goal/Idea graphs with empty evidence manifests need new producer-bound evidence and an independent signature/claim verification path. Plan proposals missing `supportingEvidenceRefs` or authenticated current-snapshot bindings remain ineligible. Do not manufacture Execution Graph proposals to make counts appear complete.

## Validation record

- `npm test`: PASS, exit `0`; final log `/tmp/runalith-npm-test-rc24-runtime-entrypoint-consistency-20261028-verified.log`, SHA-256 `766787e5968fbfd84cc0f35ee7f2bd940d5f8f7b0967157ee6d6b42aa9b86dab`.
- `npm run test:package-reproducibility`: PASS. `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.24-runtime-entrypoint-consistency-20261028.mcpb`: `MCPB_FAST_TEST=PASS`, 74/74 tools, isolated SQLite. `unzip -t`: PASS, no compressed-data errors.
- `npm run docs:check`: PASS, 115 Markdown files / 336 local links. `npm run site:check`: PASS, version `1.0.9-rc.24`, 74 tools, RC.24 acceptance link. `git diff --check`: PASS.
- Host preflight regression: `npm run test:runalith-rollout` PASS, 16/16; includes a negative test proving candidate verification rejects `scripts.start` pointing at a different versioned entrypoint.
- The package build and local E2E pass do not authenticate production trust or grant release/dispatch authority.

## Production blockers

All six RC.23 gates remain open unless fresh independent evidence closes them:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: the contract owner must supply the signed canonical 71-path manifest; the controlled builder must supply a receipt for the exact candidate/source tree; platform security must pin disjoint authority and builder roots. Do not trim the 93-entry candidate or infer paths from cardinality.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: independent release authority must provide candidate/baseline/rollback-bound provenance, verification envelope and approval, using a host-issued single-use nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: verifier and reviewer administrators must independently provision versioned public-only JSON trust configs, distinct provider IDs and disjoint Ed25519 SPKI roots/scopes; verify effective host runtime config, key windows, rotation/revocation and anti-rollback.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: platform security must provision the host-owned authenticated adapter and independent monotonic store, and verify fresh continuity, nonce consumption and CAS receipt.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: workflow owners/provider/runtime operators must reconcile each executing job and approve its disposition.
6. `RUNNING_TASKS_MUST_DRAIN`: reconcile each running task against event/attempt/result/artifact lineage, provider execution state, owner epoch and authoritative lease before any lifecycle decision.

Fresh final preflight: `/tmp/runalith-preflight-rc24-runtime-entrypoint-consistency-20261028-v2.json`, SHA-256 `03dfcfcf40845efc966afd1a3274634cd4a9d4d1d1e90eeb7e021f75a9db6ff6`; exit code `3`, `BLOCKED`, `canActivateNow=false`, read-only, no live mutation and checkpoint transition `NOT_REQUESTED`. All six rollout blockers remain open.

No live DB write, graph mutation, host config/registry edit, process restart/kill, package activation, external checkpoint transition or production dispatch occurred. Keep rollout `BLOCKED` until every gate has independent, authoritative and reproducible evidence.
