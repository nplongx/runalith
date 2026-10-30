# Runalith RC.60 rollout record — superseded, validation incomplete

- Candidate: `dist/runalith-1.0.9-rc.60-trust-metadata-provenance-fix-20261029.mcpb`
- SHA-256: `dfa85988b22aa0a75ef27b1ef215bdb7dd24ae111f7242c73b1182dea7a62dd4`
- Size: 949,502 bytes; 105 entries; 74 tools.
- Entrypoint: `server/index-v1.0.9-rc.60.js`, SHA-256 `15d64416436160150a6c6d9fb50fda08fec5a1310a4d1aa678f53e2261bd839d`.
- Rollback baseline: RC.26, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- Fixture v97 SHA-256 `d80b621e9390b9fa77e276f30a51f607586b7f606bee387a2145ea210951a0b6`; historical v95 and v96 remain unchanged.

The RC.60 package metadata parity fix aligns `package.json.main`, `runtimeEntryPoint`, `npm start`, manifest entry point and launch args. Candidate-specific source alignment, MCP fast test, ZIP integrity, focused tests (23/23), benchmark and direct read-only sandbox tool calls passed. Source alignment proves exact local archive-entry bytes only; it does not establish authenticated builder provenance.

The recorded full-suite run was interrupted before exact completion statuses were captured. Subsequent package reproducibility/no-overwrite validation exposed stale expected package-root inventory (the acceptance-consistency test and verifier were packaged but omitted from the expected input set). RC.60 is not accepted; RC.61 records that correction and its own full-suite failure, and RC.62 is the current validation candidate.

Rollout remains `BLOCKED`, `canActivateNow=false`. No production install/activation, live workflow mutation, trust-ledger write, external checkpoint transition or Git history mutation occurred.
