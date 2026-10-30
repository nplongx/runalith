# Runalith RC.61 rollout record — superseded, not accepted

Date: 2026-10-29. RC.61 is an immutable intermediate candidate. Do not install or activate it.

## Candidate identity

- Archive: `dist/runalith-1.0.9-rc.61-acceptance-inventory-fix-20261029.mcpb`
- SHA-256: `4d8729cce8067aad55a8d32dbb2b12c011d9256d6683fef7e358c4e9328cb92b`
- Size: 949,502 bytes; 105 ZIP entries; 74 MCP tools.
- Entrypoint: `server/index-v1.0.9-rc.61.js`, SHA-256 `15d64416436160150a6c6d9fb50fda08fec5a1310a4d1aa678f53e2261bd839d`.
- Rollback baseline: `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.

## Purpose and results

RC.61 corrects package reproducibility/no-overwrite expected package roots to include `tests/test-agg-acceptance-consistency.mjs` and `scripts/verify-agg-acceptance-consistency.mjs`. It advances package/manifest/lock/start entrypoint identity and immutable benchmark fixture v98.

- Pack and extracted-package E2E: exit 0.
- Source alignment: exit 0; report `artifacts/adaptive-goal-graph/source-alignment-rc61-current-20261029.json`, SHA-256 `7ea23dcba49c12fef6a11479a732965ad16c03b2a48352deb5a0e091a5d423a6`.
- MCP fast test: exit 0; `/tmp/runalith-rc61-mcp-fast-test-20261029.log`, SHA-256 `e2b389fb74d501f6beca39f9037491cfb65490c9dd656c606e2f248afba62c31`.
- ZIP integrity: exit 0; `/tmp/runalith-rc61-zip-test-20261029.log`, SHA-256 `1645647a8a095b9c4dacaeac99024e81f495b17a06d570f705604bae17959e0f`.
- Focused tests: exit 0, 23/23; `/tmp/runalith-rc61-focused-20261029.log`, SHA-256 `484545105397565a270a9e9023162f243a3f44c327d57941d7c3303d95b25e3b`.
- Full `npm test`: **exit 1**. `tests/test-agg-acceptance-consistency.mjs` used fixed `NOW=2026-10-29T05:50:00Z`; by this run, its fixture preflight observation was over one hour old and the CLI freshness check correctly returned exit 3. The failure was a time-dependent test fixture, not a production-oracle failure.
- Phase 2 security regressions: exit 0; `/tmp/runalith-rc61-phase2-security-20261029.log`, SHA-256 `6f43376b5626923e822fb531ccd52706a589048717675c06b2a1f39e95ddd86c`.
- RC.61 was not accepted because full `npm test` failed. RC.62 fixes the test clock by using wall-clock-relative fixture timestamps and preserves v98 as historical bytes.

Source alignment only proves local source/archive byte identity; no authenticated builder receipt or independent release authority was present. RC.61 never received production activation authority.
