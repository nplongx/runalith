# Goal/Idea → Plan → Execution Graph acceptance — RC.59

> **Historical intermediate candidate, superseded by RC.60.** Full integration found a package main/start mismatch. See [RC.60 acceptance handoff](goal-plan-execution-acceptance-rc60-20261029.md) for the corrected metadata and final validation.

## Candidate

`dist/runalith-1.0.9-rc.59-trust-reconciliation-acceptance-20261029.mcpb` — SHA-256 `d06324fe7de3db0b7af1c2a7443fd4ddfa91598058b8907b9a97d97a54ab4d63`.

## Verified locally

- Source-aligned MCPB with 105 archive entries and 74 manifest/runtime tools; ZIP integrity and extracted-package E2E are part of candidate validation.
- v96 benchmark fixture refreshes local source pins after the package-version change and preserves v95 byte-for-byte. This resolves the concrete `PROVENANCE_SOURCE_HASH_MISMATCH` seen in the RC.58 full test run without weakening the frozen graph/evidence/path oracle.
- Goal/Idea snapshot GET and search are tested as trust-ledger read-only operations. Invalid signatures, wrong scope, stale snapshots, replay, provenance mutation and unavailable reviewer trust continue to fail closed in isolated producer-to-dispatch E2E tests.
- Plan Graph evidence requirements and dependency ancestry, authenticated current-snapshot binding, immutable plan pinning, reviewer identity, persisted review-only Execution Graph proposal and dispatch boundary remain covered by existing E2E and negative tests. Test-only Ed25519 trust is confined to disposable DBs and is not production authority.
- Schema-v2 reconciliation preserves provider runs with missing task binding, catches unmatched lease references and avoids false per-task event truncation attribution. The new acceptance verifier checks actual candidate/archive bytes, cross-report hashes, expected validation exit codes, stale live observations and all six required gate codes.

## Current live graph state

Host-connected snapshot `runalith-agg-e2e-20261026-clean` retains hash `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, but it is not attested: `verified=false`, `eligibleForAttestation=false`, and the evidence manifest is empty. There are 22 Plan Graph steps without supporting evidence, 3 proposals without authenticated current-snapshot binding, and 0 persisted Execution Graph proposals.

## Acceptance decision

**Production acceptance remains blocked.** The 105-entry candidate does not establish the signed canonical Phase 2 contract of 71 paths. There is no authenticated controlled-builder receipt, independent release approval, production trust provisioning, external checkpoint continuity proof or per-record job/task drain disposition. The acceptance-consistency tool is an integrity/freshness guard only; it cannot grant release authority.
