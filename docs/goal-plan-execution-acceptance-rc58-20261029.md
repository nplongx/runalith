# Goal/Idea → Plan → Execution Graph acceptance — RC.58

> **Historical intermediate candidate, superseded by RC.59.** The first full suite detected a stale v95 package-version provenance pin. See [RC.59 acceptance handoff](goal-plan-execution-acceptance-rc59-20261029.md); RC.58 archive bytes and failure logs are preserved.

## Scope

Candidate: `dist/runalith-1.0.9-rc.58-acceptance-reconciliation-hardening-20261029.mcpb`, SHA-256 `3e0ae97e4fcf953833ce15c126c4e75b5ef135756c30392b0f1269f9e58d6a36`.

## New regression coverage

- **Read-only trust semantics:** `adaptive_goal_knowledge_snapshot_get` and `adaptive_goal_knowledge_search` do not append trust-ledger high-water rows. The explicit trust-status operation remains a distinct state-changing boundary.
- **Host identity:** `validate-agg-trust-config.mjs` rejects `--proc-root` on the production CLI. The test harness may inject a fixture root through the imported API, but that cannot be presented as live host evidence by the CLI.
- **Provider-run correlation:** nonterminal provider-run rows with `NULL task_id` remain visible as unbound; unmatched provider-run lease IDs block disposition even when the active lease set is empty; owner epochs are compared only for the exact matching lease.
- **Event correlation:** bounded scan truncation is attributed to a task only when the task ID was actually found. Unattributed truncation is a job-level finding and cannot falsely mark every task as individually incomplete.
- **Acceptance consistency:** the new verifier checks actual ZIP integrity, manifest version, entrypoint bytes, archive entry count, candidate/rollback hashes, source alignment, preflight, dossier, remediation, evidence file hashes/sizes, no-mutation assertions, all six gate codes and live-observation freshness. Negative tests cover stale snapshots, candidate tampering and CLI misuse.
- **Existing end-to-end gates:** typed producers, complete Plan Graph evidence, signed current snapshot, immutable plan pinning, independent reviewer identity, persisted review-only Execution Graph proposal and dispatch fail-closed remain covered by the existing isolated producer-to-dispatch E2E and negative regressions. Test-only keys are never production trust.

## Current observed state

The latest host-connected snapshot reproduces hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3` for `runalith-agg-e2e-20261026-clean`, but the live verifier is unavailable, `verified=false`, `eligibleForAttestation=false`, and the evidence manifest is empty. The current workflow DB reconciliation still observes 22 Plan Graph steps without supporting evidence, 3 proposals without authenticated snapshot binding and no persisted Execution Graph proposals.

The current candidate inventory has 105 entries; the canonical signed Phase 2 contract is still 71 paths and was not supplied. RC.58 byte alignment is local integrity only, with no authenticated builder receipt or independent release approval. Production trust configuration is blank, the external monotonic checkpoint is not verified, and per-job/per-task drain remains unresolved.

## Acceptance decision

**Production acceptance remains blocked.** Use `scripts/verify-agg-acceptance-consistency.mjs` to detect internal artifact drift and stale evidence; it does not replace signed authority, trust provisioning, checkpoint-store receipts, or owner/provider lifecycle dispositions. Do not activate or dispatch from this candidate until all six release gates are closed by their respective authorities.
