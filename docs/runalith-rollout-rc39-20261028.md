# Runalith RC.39 rollout dossier — 2026-10-28

**Decision: `BLOCKED`; do not install or activate RC.39.** This successor hardens the schema-v2 lifecycle reconciliation input contract used by the read-only AGG remediation compiler. Unlike RC.38, it explicitly requires a `false` value for the external security store mutation marker as well as runtime and workflow-database mutation markers. Missing the external-store marker now fails closed.

**Superseded by RC.40 for further validation.** The preserved RC.39 archive SHA-256 is `3d25bddfb2d7ab73187e91d66a0711767d7a32b6bca03f8d0786bd680a7bfe4a` (916,389 bytes). Its read-only rollout preflight exited 1 because `manifest.server.mcp_config.args` still referenced the RC.38 entry point, even though `manifest.server.entry_point`, package `main` and `npm start` referred to RC.39. That archive was not modified or overwritten.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.39-external-mutation-marker-20261028.mcpb`.
- Entrypoint: `server/index-v1.0.9-rc.39.js`; package version `1.0.9-rc.39`.
- RC.38 remains preserved: `dist/runalith-1.0.9-rc.38-dual-reconciliation-lineage-20261028.mcpb`, SHA-256 `d8228a615f351e9d62565c3172093e02ab78e60595898684bbef8706fe0396bc`.
- Rollback reference remains `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.

## Implementation and evidence

The lifecycle reconciliation input must now explicitly include all three negative mutation assertions. The regression suite verifies that removing `externalSecurityStoreMutationPerformed` causes rejection. This validates the *input contract* only; it does not independently prove the report producer or host avoided an external mutation.

RC.39 was never production-authorized. Its preflight failure is a package metadata contract finding, separate from the six release blockers below. The successor RC.40 corrects launch-argument alignment and adds regression coverage. The evidence records are deliberately separate from source snapshots to avoid self-referential hashes.

## Safety and release decision

No production installation/activation, host restart/kill, live workflow database mutation, plugin registry/configuration change, trust-ledger write, external checkpoint transition, or real workflow/provider dispatch is authorized or performed. No commit or push is performed. The serving runtime remains RC.26.

All six release gates remain open until independently verifiable evidence and authority decisions exist:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
6. `RUNNING_TASKS_MUST_DRAIN`

The current read-only workflow inventory previously identified 60 jobs requiring owner/provider/runtime reconciliation and 61 running tasks without active lease rows. Missing leases are not evidence of worker death and do not authorize retries, resets, terminalization, cancellation, process intervention or redispatch.
