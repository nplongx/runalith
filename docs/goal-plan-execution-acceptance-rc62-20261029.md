# RC.62 Goal/Idea → Plan → Execution acceptance record

Candidate `dist/runalith-1.0.9-rc.62-acceptance-freshness-test-fix-20261029.mcpb`, SHA-256 `2d1528594ad5c7a1b96e7e711e6fdd45d6415e31da1842219178d67c7cbac655`.

## Verified local acceptance checks

- Package/entrypoint parity: `package.json`, `package-lock.json`, `plugin/manifest.json`, `npm start`, and archive manifest identify RC.62; 105 archive entries, 74 tools.
- Source alignment: `artifacts/adaptive-goal-graph/source-alignment-rc62-current-20261029.json`, SHA-256 `e22f4684933b52f9dbb399d0378a5fdeb0f3a463869d1ba391c99099faefab54`; byte identity passes, authenticated build provenance does not.
- Full `npm test` exit 0; Phase 2 security rerun exit 0 after one retained transient EOF/backpressure failure; focused 23/23; package reproducibility and no-overwrite exit 0; MCP fast test and ZIP integrity exit 0.
- Fresh read-only host reports: reconciliation v1 `artifacts/adaptive-goal-graph/live-reconciliation-v1-rc62-final-20261029.json`, SHA-256 `08168b25df602445a1fb5271adb0e76437ca2da3d6f18a68615fef7392bc82ef`; v2 `artifacts/adaptive-goal-graph/live-reconciliation-v2-rc62-final-20261029.json`, SHA-256 `f4be5bddf844ae9d5884155255d383fdf396675c03bb9e280372d1d308ebb881`.
- Snapshot observation `artifacts/adaptive-goal-graph/live-snapshot-rc62-dossier-final-20261029.json`, SHA-256 `ce399c8b399803d134668b2faad38df33ddd5665391df8902c65af31a07563c7`: snapshot hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, `verified=false`, `eligibleForAttestation=false`, empty evidence manifest.
- Host trust diagnostic `artifacts/adaptive-goal-graph/trust-diagnostic-rc62-acceptance-final-20261029.json`, SHA-256 `95fed04ea6d0f4a940550b672f683e9321a304af9da2076e022b3f480f657bf1`: host RC.26; verifier/reviewer configs absent or blank; external checkpoint not verified.

## Fail-closed production acceptance

Preflight `artifacts/adaptive-goal-graph/rollout-preflight-rc62-acceptance-final-20261029.json` SHA-256 `505f1179054d9190bcff9dc5da9dedf86fecce05f80c448fab95872d8261df81`, exit 3; dossier `artifacts/adaptive-goal-graph/agg-readiness-dossier-rc62-dossier-final-20261029.json` SHA-256 `2c5ea393ae78021c1b01e744aa2ab66a52033c4a93c937cfdb024d3b2d8ef92a`, exit 3; remediation `artifacts/adaptive-goal-graph/agg-remediation-plan-rc62-dossier-final-20261029.json` SHA-256 `863f270ce7194ee8a85d298d8a2e6fd4728abbab4c591783b3213d17efdc2004`, exit 0 with `mutationAuthorized=false`.

All six gates remain open: frozen 71-path contract, independent release evidence, production trust configuration, external trust-ledger anchor, active workflow drain, running task drain. Acceptance consistency checks integrity and freshness only; it cannot grant release authority. Keep rollout `BLOCKED`, `canActivateNow=false`.


Acceptance evidence index: `artifacts/adaptive-goal-graph/acceptance-evidence-rc62-20261029.json`, SHA-256 `48be52b806cf02ef46d780d34e8559cc8397b187498591a704185ffd99adc0db`. Acceptance consistency report: `artifacts/adaptive-goal-graph/acceptance-consistency-rc62-final2-20261029.json`, SHA-256 `3f38e22c019ef9102dcc97eee5776a878d452eb1431b5866e0a94ef09108b567`, exit 0, `result=PASS`, zero consistency blockers. This is integrity/freshness consistency only; rollout is still `BLOCKED`, `canActivateNow=false`.


Per-record read-only running-task evidence: `artifacts/adaptive-goal-graph/running-tasks-without-active-leases-rc62-20261029.json`, SHA-256 `d17443bca747ff482b1b6c546ab943c872ddd78f7c1c170b294065ceb23ad736`. It records all 61 running tasks without active lease rows, per-task attempt/result/artifact/event/lease lineage, missing authoritative owner identity, and explicit prohibitions on retry, terminalization, drain or dispatch. Absence of a lease is not interpreted as worker death.
