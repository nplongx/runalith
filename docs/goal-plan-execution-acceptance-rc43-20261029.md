# Goal / Plan / Execution Graph acceptance — RC.43

**Local implementation validation is not production trust or release approval.** This document records the RC.43 implementation delta and preserves all external-authority gates.

## Implemented contract coverage

- Goal/Idea producer outputs use typed durable artifacts and exact result/attempt/event/artifact lineage. Empty evidence manifests and caller-asserted verification metadata do not establish attestation eligibility.
- Goal/Idea snapshot verification binds canonical graph identity, node revisions, memberships, edge provenance, evidence manifest, signature, configured trust root, validity and anti-replay nonce. Trust-root provisioning remains host-owned.
- Plan Graph drafts bind authenticated current-snapshot identity and evidence; missing supporting evidence, stale source bytes, or unverified claims remain blockers.
- Execution Graph proposals are deterministic, persisted and read back by event/job identity in isolated E2E. Review-only proposals do not by themselves authorize dispatch.
- Reviewer identity is scoped and signature-verified against configured roots, with expiry, revocation and nonce replay rejection. Immutable plan pinning and final dispatch checks remain required.
- Runtime lifecycle recovery fails closed when quarantined remote effects, native specialist runtime records, or legacy provider-run records make external outcomes uncertain.
- RC.43 read-only reconciliation now includes `provider_runs` records where schema permits, their task/job binding status, run/attempt/lease/owner-epoch identifiers, nonterminal state, and mismatch diagnostics. Legacy job-only provider-run schemas are explicitly ambiguous. Remediation output retains these fields and authorizes no lifecycle action.
- Benchmark fixture v83 refreshes current source pins while preserving v82 byte-for-byte. These pins establish local source identity only.

## Local validation

- Full `npm test`: exit code 0 after RC.43 source, package and fixture changes.
- `node --test tests/test-reconcile-active-workflows-v2.mjs tests/test-agg-live-remediation-plan.mjs`: passed, including task-bound provider-run and legacy job-only provider-run regressions.
- `npm run pack:runalith-mcpb` with `PLUGIN_BUNDLE_OUT=dist/runalith-1.0.9-rc.43-provider-run-lineage-20261029.mcpb`: package build, source-byte alignment, extracted acceptance tests and 74/74 MCP tool smoke passed.
- `npm run docs:generate-reference`: generated reference from RC.43 source runtime, 74 tools.
- `npm run docs:check`: passed, 143 Markdown files and 358 local links.
- Archive ZIP integrity: passed; 103 entries, zero duplicate entry names.
- Final source-alignment and rollout-preflight reports are versioned under `artifacts/adaptive-goal-graph/` and must be consulted for exact report hashes and the current decision.

## Current observed state

The latest read-only reconciliation reports 138 jobs, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 5,309 events, 119 approvals and zero task-lease rows. It observes 86 jobs for reconciliation, 60 stale candidates, and 61 running tasks without active lease rows. No terminal disposition is independently verified. The live schema does not expose a `provider_runs` table, so the new provider-run report field is `TABLE_MISSING` for observed tasks; this is a schema observation, not evidence that no remote provider effects occurred.

The Goal/Idea snapshot remains ineligible for attestation because its evidence manifest is empty. The latest observed Plan Graph findings include 22 steps lacking supporting evidence and three proposals without authenticated snapshot binding; no persisted Execution Graph proposals were observed. Historical source-hash mismatch records remain preserved; cause and repair require source-owner reconciliation.

## Release blockers — all OPEN

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`
6. `RUNNING_TASKS_MUST_DRAIN`

The candidate has no authenticated builder receipt, independent release evidence, production trust configuration proof, or verified external checkpoint anchor. No live workflow mutation, trust-ledger mutation, checkpoint advance, install, activation, or dispatch was performed. Rollout preflight remains `BLOCKED`, exit code `3`, `canActivateNow=false`.
