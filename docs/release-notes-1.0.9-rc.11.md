# Runalith 1.0.9-rc.11 — pre-release notes

**Status: testing pre-release only. Production rollout remains BLOCKED.**

This release consolidates the Goal/Idea Graph → Plan Graph → Execution Graph implementation and workflow reliability hardening. It is intended for controlled testing and review, not unattended production activation.

## Published artifact identity

- GitHub release: [Runalith 1.0.9-rc.11 (Testing Pre-release)](https://github.com/nplongx/runalith/releases/tag/v1.0.9-rc.11), published 2026-10-26.
- Tag: `v1.0.9-rc.11`.
- Source commit: `ffee0815b8dfcac21d15d8eaeaf1d309aab2b7e2` (`feat: harden adaptive goal graph and workflow reliability`).
- Asset: [`runalith-1.0.9-rc.11-goal-idea-authenticated-projection-v22.mcpb`](https://github.com/nplongx/runalith/releases/download/v1.0.9-rc.11/runalith-1.0.9-rc.11-goal-idea-authenticated-projection-v22.mcpb), 807,458 bytes.
- SHA-256: `37c1d418f743190e1d1843995346c9e3296dafd29e47de1e42afb47b6f2870fd`.
- Archive: 93 entries; manifest/runtime tool count: 74.

The tag resolves to the recorded source commit, and the release asset digest was verified against the published asset metadata. The package was **not** installed or activated in the target host as part of publication. See the [RC.11 acceptance record](goal-plan-execution-acceptance-rc11-20261026.md) for scope and observed blockers.

## Highlights

- Adds typed Goal/Idea snapshot verification and authenticated verifier-report provenance, exact graph/evidence binding, and fail-closed proposal reconstruction.
- Hardens Plan Graph projection and Execution Graph proposal authentication against caller-forged verification state and evidence substitution.
- Adds reviewer identity and approval-authority contracts with explicit trust configuration boundaries.
- Adds adversarial tests for signature and scope violations, stale/replayed snapshots, provenance mutation, trust-root separation, rotation/revocation, and anti-rollback behavior.
- Adds a protocol-level Ed25519 external checkpoint-response verifier with nonce, release-hash, freshness, sequence and chain-continuity checks. The verifier explicitly does **not** establish production authority without an independently authenticated host-owned adapter and protected monotonic store.
- Adds read-only per-job/task workflow reconciliation that correlates event, attempt, result, artifact, lease and execution metadata; missing lease or owner/provider metadata is not treated as proof that a worker is dead.
- Preserves historical benchmark fixtures and evidence; new validation evidence is stored as successor artifacts rather than rewriting historical records.

## Validation

The release-time offline acceptance run passed the full `npm test` suite, package reproducibility, MCP fast test, archive integrity, source-to-bundle alignment, documentation/link checks, `git diff --check`, and historical checksum verification. The release-time documentation check covered 87 Markdown files and 273 local links. The candidate archive SHA-256 is:

`37c1d418f743190e1d1843995346c9e3296dafd29e47de1e42afb47b6f2870fd`

Offline tests are not production authority and do not prove the active host loaded the candidate.

## Known release blockers

Production rollout must remain blocked until all of the following are independently verified:

1. Host-owned verifier and reviewer trust JSON configurations are provisioned and their effective runtime values, distinct providers/roots, scope, version and revocation state are independently checked.
2. A host-owned checkpoint adapter and independently protected external monotonic store provide authenticated challenge responses and verified anti-rollback continuity.
3. The 60 previously observed `EXECUTING` jobs and 61 running tasks are reconciled per record against authoritative owner, provider/runtime identity, lease fencing, and durable event/attempt/result/artifact lineage. Missing lease rows alone do not prove worker death.

The package has not been installed or activated by this release workflow. Do not use this pre-release to bypass the outstanding gates.
