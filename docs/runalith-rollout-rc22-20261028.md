# Runalith RC.22 rollout dossier — 2026-10-28

## Decision

**SUPERSEDED by RC.23 before final acceptance; production remains BLOCKED.** RC.22 introduced explicit opt-in source mismatch details, but a subsequent regression found that expected digest extraction from the historical `file:` URI needed a fallback when `details_json` was empty. Use RC.23 as the current candidate.

## Candidate

- Path: `dist/runalith-1.0.9-rc.22-actionable-source-mismatch-recovery-20261028.mcpb`
- Version: `1.0.9-rc.22`; entrypoint: `server/index-v1.0.9-rc.22.js`.
- Superseded archive SHA-256: `ebee840aabaf97ca98d09f736b660a3300912549e80cf2645d915ab9a9ec5189`; 852,309 bytes; 93 entries; 74 tools. Build-time source snapshot: `70c6aea8024bbb1f7a31b953f63f83f219a7075f972c69f561bdc8651b370bcc`.
- Benchmark fixture v64: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v64.json`; v63 and earlier are preserved byte-for-byte.

## RC.22 change and safe operation

Default planner evidence output continues to expose only a SHA-256 identifier for a historical reference. For a specific mismatch, an authorized operator may run:

```sh
node scripts/reconcile-active-workflows.mjs \
  --db "$HOME/.chat-on-steroids/agent-orchestrator/workflow.db" \
  --limit 200 \
  --include-sensitive-source-identifiers \
  --out /tmp/runalith-reconcile-sensitive-unique.json
```

Use a new unique output path. The report is read-only; the output is created with mode `0600`. It adds the exact `file:` URI, expected and observed SHA-256, and source resolver classification. Keep it in restricted operational storage and do not commit or bundle it. Historical rows and hashes must not be rewritten. A changed source can only support new evidence after the claim owner confirms semantic relevance and the approved producer path creates a new durable record.

## Validation artifacts

RC.22 `npm test` exit 0; log SHA-256 `71d9dc4a931a1394f53060675d9b5ef5124fe6a611bd9bddb0e033bc64882f7e`. Package reproducibility, MCP fast test and ZIP integrity passed. The candidate was superseded after a code correction; the current acceptance artifacts are in the RC.23 dossier.

## Six blockers and required authorities

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: Phase 2 contract owner issues a canonical owner-signed manifest containing exactly 71 sorted unique portable paths; controlled builder signs receipt for the exact candidate/source/tree; platform security pins distinct authority and builder SPKI roots. Never trim a 93-entry archive or infer authority from entry count.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: independent release authority issues signed builder provenance, independent verification envelope and approval bound to candidate/baseline/rollback digests and host-issued single-use nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: separate verifier and reviewer administrators provision versioned public-only JSON configs, distinct provider IDs, disjoint Ed25519 SPKI roots, exact scopes and effective runtime status; verify anti-rollback history.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: platform security provisions the host-owned authenticated checkpoint adapter and independent monotonic store; obtain fresh signed continuity, nonce-consumption proof and compare-and-swap commit receipt.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: workflow owners plus provider/runtime operators reconcile each job's event, attempt, result, artifact, owner, provider, runtime and lease state before authorizing a lifecycle disposition.
6. `RUNNING_TASKS_MUST_DRAIN`: same authorities reconcile each running task's exact attempt/completion/artifact lineage, provider execution status and authoritative lease/owner epoch. Missing lease is not evidence of worker death.

No live workflow DB write, graph mutation, host config/registry edit, process restart/kill, package activation, external checkpoint transition or production dispatch is permitted in this work. Do not claim READY until every gate has independently verifiable evidence.
