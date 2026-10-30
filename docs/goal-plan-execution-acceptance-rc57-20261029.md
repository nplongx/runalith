# Goal/Idea → Plan → Execution Graph acceptance handoff — RC.57

## Acceptance scope

Candidate: `dist/runalith-1.0.9-rc.57-readonly-trust-inspection-20261029.mcpb` (`bf47b00c352da2ee3b5caeae61c11a15a1e550e703a08f19d6df7d40dbdf57c4`). This acceptance record distinguishes isolated tests from current live observations and from independent release authority.

## Verified in isolated tests

- Source-verifier trust configuration: exact schema/scope, missing/blank/malformed config rejection, distinct provider IDs and disjoint canonical SPKI roots, controlled key overlap rotation, revocation and validity windows, anti-rollback and durable ledger reopen.
- Goal/Idea snapshots: canonical content and immutable revision/membership/edge provenance checks; signatures bind the current snapshot/evidence manifest; tampering and nonce replay fail closed; expiry removes authority.
- Plan Graph: explicit action/task mapping, required dependency ancestry, typed producer outputs and supporting evidence checks; unverified sources cannot establish planning authority.
- Execution Graph: persisted review-only proposal requires fresh Plan Graph proposal, current snapshot binding, typed artifacts and exact producer/result/attempt/completion lineage. Failed readiness does not persist an executable proposal.
- Post-approval races reject expired reviewer signatures, altered artifacts, stale source graphs and missing reviewer authority without dispatch or task side effects. Isolated E2E can dispatch only within a private disposable database under test-only trust; this is not production authority.
- Lifecycle and checkpoint regressions reject replay, signature/hash substitution, rollback, stale challenge and missing atomic nonce/high-water transitions.
- Package manifest/runtime schema parity is checked for all 74 tools; the two trust-sensitive descriptions are explicitly parity-tested.

## Current live acceptance state

Live read-only reconciliation remains blocked: Goal/Idea evidence manifests are empty and snapshots are not verifier-attested; 22 Plan Graph steps lack supporting evidence; 3 proposals lack authenticated current-snapshot binding; there are zero persisted Execution Graph proposals. No live graph, trust ledger, workflow row or external checkpoint was modified to make tests pass.

## Required before production acceptance

1. Supply the authority-signed canonical 71-path Phase 2 contract and candidate-bound builder receipt.
2. Supply independent RC.57 build/verification/release approval bound to the candidate SHA-256, rollback baseline and host nonce.
3. Provision and verify host-owned verifier/reviewer trust configurations, distinct provider IDs, disjoint trust roots, rotation/revocation and effective configuration ledger.
4. Supply independently verified external checkpoint continuity and atomic CAS evidence.
5. Resolve each executing job and running task individually with authoritative owner/provider/runtime and event/attempt/result/artifact/lease/fencing evidence.
6. Re-run read-only reconciliation and rollout preflight after authority actions. Keep activation disabled until all gates close.

Machine-readable companion: `artifacts/adaptive-goal-graph/acceptance-evidence-rc57-20261029.json`.
