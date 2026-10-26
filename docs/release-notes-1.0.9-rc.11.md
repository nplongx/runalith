# Runalith 1.0.9-rc.11 — pre-release notes

**Status: testing pre-release only. Production rollout remains BLOCKED.**

This release consolidates the Goal/Idea Graph → Plan Graph → Execution Graph implementation and workflow reliability hardening. It is intended for controlled testing and review, not unattended production activation.

## Highlights

- Adds typed Goal/Idea snapshot verification and authenticated verifier-report provenance, exact graph/evidence binding, and fail-closed proposal reconstruction.
- Hardens Plan Graph projection and Execution Graph proposal authentication against caller-forged verification state and evidence substitution.
- Adds reviewer identity and approval-authority contracts with explicit trust configuration boundaries.
- Adds adversarial tests for signature and scope violations, stale/replayed snapshots, provenance mutation, trust-root separation, rotation/revocation, and anti-rollback behavior.
- Adds a protocol-level Ed25519 external checkpoint-response verifier with nonce, release-hash, freshness, sequence and chain-continuity checks. The verifier explicitly does **not** establish production authority without an independently authenticated host-owned adapter and protected monotonic store.
- Adds read-only per-job/task workflow reconciliation that correlates event, attempt, result, artifact, lease and execution metadata; missing lease or owner/provider metadata is not treated as proof that a worker is dead.
- Preserves historical benchmark fixtures and evidence; new validation evidence is stored as successor artifacts rather than rewriting historical records.

## Validation

The recorded offline acceptance run passed the full `npm test` suite, package reproducibility, MCP fast test, archive integrity, source-to-bundle alignment, documentation/link checks, `git diff --check`, and historical checksum verification. The candidate archive SHA-256 is:

`37c1d418f743190e1d1843995346c9e3296dafd29e47de1e42afb47b6f2870fd`

Offline tests are not production authority and do not prove the active host loaded the candidate.

## Known release blockers

Production rollout must remain blocked until all of the following are independently verified:

1. Host-owned verifier and reviewer trust JSON configurations are provisioned and their effective runtime values, distinct providers/roots, scope, version and revocation state are independently checked.
2. A host-owned checkpoint adapter and independently protected external monotonic store provide authenticated challenge responses and verified anti-rollback continuity.
3. The 60 previously observed `EXECUTING` jobs and 61 running tasks are reconciled per record against authoritative owner, provider/runtime identity, lease fencing, and durable event/attempt/result/artifact lineage. Missing lease rows alone do not prove worker death.

The package has not been installed or activated by this release workflow. Do not use this pre-release to bypass the outstanding gates.
