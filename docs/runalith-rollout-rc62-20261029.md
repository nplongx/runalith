# Runalith RC.62 rollout record

Date: 2026-10-29. Local validation candidate only; production activation remains blocked.

## Candidate identity

- Archive: `dist/runalith-1.0.9-rc.62-acceptance-freshness-test-fix-20261029.mcpb`
- SHA-256: `2d1528594ad5c7a1b96e7e711e6fdd45d6415e31da1842219178d67c7cbac655`
- Size: 949,580 bytes; 105 ZIP entries; 74 MCP tools.
- Entrypoint: `server/index-v1.0.9-rc.62.js`, SHA-256 `15d64416436160150a6c6d9fb50fda08fec5a1310a4d1aa678f53e2261bd839d`.
- Package `version`, `main`, `runtimeEntryPoint`, `scripts.start`, manifest `version`, `server.entry_point`, MCP launch args, and package-lock root version all identify RC.62.
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- Fixture v99: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v99.json`, SHA-256 `5fe6b907f7f3833985649cde5ae25d31ef28fe8c6a922b6c2fdd57563d7cde65`. v98 remains immutable at SHA-256 `4b0f515b9ddb2eae4861e0d91eea2efa30403e64d1a818d2891433b9550549ca`; v97 remains immutable at SHA-256 `d80b621e9390b9fa77e276f30a51f607586b7f606bee387a2145ea210951a0b6`.

## Implementation and validation

RC.62 changes the acceptance-consistency test fixture clock from a fixed historical instant to `Date.now()`. The stale-snapshot negative test remains one hour old relative to that clock and continues to assert fail-closed behavior. No acceptance predicate, frozen path contract, or production trust policy was weakened.

- Pack and extracted-package E2E: `npm run pack:runalith-mcpb` exit 0; `/tmp/runalith-rc62-pack-20261029.log`.
- Source alignment: exit 0; `artifacts/adaptive-goal-graph/source-alignment-rc62-current-20261029.json`, SHA-256 `e22f4684933b52f9dbb399d0378a5fdeb0f3a463869d1ba391c99099faefab54`. Report says exact archive-entry bytes match but authenticated builder receipt/independent authority remain absent.
- MCP fast test: exit 0; `/tmp/runalith-rc62-mcp-fast-test-20261029.log`, SHA-256 `ee03eb93107ac9822599cd348ff937e1c58a2cf164f5c26b0a96c2ebb1e9b506`.
- ZIP integrity: exit 0; `/tmp/runalith-rc62-zip-test-20261029.log`, SHA-256 `16b25b6343be4ef72da755179ce64d426790c7f905036622179aa343292451a8`.
- Focused benchmark/source-alignment/evidence-pack/acceptance tests: exit 0, 23/23; `/tmp/runalith-rc62-focused-20261029.log`, SHA-256 `e9611f3077a1b546dc3f0cdbadfa31e309c73bd6e9343a3c98dba9e1fb84a966`.
- Full `npm test`: exit 0; `/tmp/runalith-rc62-npm-test-20261029.log`, SHA-256 `bd6cab88e4740f387e1ff70bc6a7143c5c36929e3bbe542b9c309bcae71d8c2b`.
- Phase 2 security regressions: first run exit 1 from EOF/backpressure shutdown exceeding the 150 ms bound; isolated rerun exit 0, `/tmp/runalith-rc62-phase2-security-rerun-20261029.log`, SHA-256 `a4ef09934a470af7e5d84c7a9ad6d580573b4b7f574c5689208196d5260cd9ab`. The initial failure is retained; rerun passed without changing the timeout oracle.
- Package reproducibility: exit 0; two independent builds byte-identical, 105 ordered entries; `/tmp/runalith-rc62-reproducibility-20261029.log`, SHA-256 `ea09c388522cc957f7290082f4b3a8bce1d32062b37cda4165c57a8effb09130`.
- Package no-overwrite: exit 0; `/tmp/runalith-rc62-no-overwrite-20261029.log`, SHA-256 `ea54c1139e55a77f8a3b276988bfbc42082d50fdb0a64690519cf4131bff0885`.
- Benchmark: exit 0; `/tmp/runalith-rc62-benchmark-20261029.json`, SHA-256 `c2f1a7f25d5b8ac0f28192dd435acd63ec348bb8d3cdd8d0a6b4f76ffb4d99d7`.
- Packaged direct tools/list, `orchestrator_health`, `workflow_catalog`, `workflow_liveness_diagnostics`, and `workflow_access_diagnostics` all exited 0. These MCPB runner calls use a private temporary DB/workspace/HOME and are sandbox-only, not production observations.

Candidate-bound read-only evidence and acceptance-consistency verification are recorded in `artifacts/adaptive-goal-graph/*rc62*` and `artifacts/adaptive-goal-graph/acceptance-evidence-rc62-20261029.json`.

Read-only evidence used by the final dossier: snapshot `artifacts/adaptive-goal-graph/live-snapshot-rc62-dossier-final-20261029.json` (SHA-256 `ce399c8b399803d134668b2faad38df33ddd5665391df8902c65af31a07563c7`); host trust diagnostic `artifacts/adaptive-goal-graph/trust-diagnostic-rc62-acceptance-final-20261029.json` (SHA-256 `95fed04ea6d0f4a940550b672f683e9321a304af9da2076e022b3f480f657bf1`); reconciliation v1 `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc62-final-20261029.json` (SHA-256 `08168b25df602445a1fb5271adb0e76437ca2da3d6f18a68615fef7392bc82ef`) and v2 `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc62-final-20261029.json` (SHA-256 `f4be5bddf844ae9d5884155255d383fdf396675c03bb9e280372d1d308ebb881`).

## Live host and release decision

The actual host still runs `server/index-v1.0.9-rc.26.js`. Host-owned `/proc` inspection found both verifier/reviewer JSON environment variables present-but-empty, provider IDs and legacy roots absent; `/etc/runalith` is absent. Current read-only reconciliation: 60 jobs need individual reconciliation; 61 running tasks lack active lease rows; 22 Plan Graph steps lack supporting evidence; 3 proposals lack authenticated current-snapshot binding; zero persisted Execution Graph proposals. No task/job lifecycle change is authorized.

Preflight and dossier exit 3 as expected, status `BLOCKED`, `canActivateNow=false`; remediation `mutationAuthorized=false`. All six release gates remain open. No production install/activation, live DB mutation, trust-ledger write, external checkpoint transition, or Git history mutation occurred.


Acceptance evidence index: `artifacts/adaptive-goal-graph/acceptance-evidence-rc62-20261029.json`, SHA-256 `48be52b806cf02ef46d780d34e8559cc8397b187498591a704185ffd99adc0db`. Acceptance consistency report: `artifacts/adaptive-goal-graph/acceptance-consistency-rc62-final2-20261029.json`, SHA-256 `3f38e22c019ef9102dcc97eee5776a878d452eb1431b5866e0a94ef09108b567`, exit 0, `result=PASS`, zero consistency blockers. This is integrity/freshness consistency only; rollout is still `BLOCKED`, `canActivateNow=false`.


Per-record read-only running-task evidence: `artifacts/adaptive-goal-graph/running-tasks-without-active-leases-rc62-20261029.json`, SHA-256 `d17443bca747ff482b1b6c546ab943c872ddd78f7c1c170b294065ceb23ad736`. It records all 61 running tasks without active lease rows, per-task attempt/result/artifact/event/lease lineage, missing authoritative owner identity, and explicit prohibitions on retry, terminalization, drain or dispatch. Absence of a lease is not interpreted as worker death.
