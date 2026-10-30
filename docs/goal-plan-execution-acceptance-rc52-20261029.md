# Goal/Plan/Execution Graph acceptance — RC.52 — 2026-10-29

## Scope

RC.52 integrates effective-host trust-domain separation diagnostics and makes the generated MCP reference stable across package-version bumps while still validating the exact `tools/list` schema output. The runtime dispatch entrypoint is byte-identical to RC.47; no claim is made that production trust or workflow lifecycle gates have been closed.

## Trust preflight invariants

- Supplied verifier/reviewer files must each pass exact schema, scope, version, key-window and canonical SPKI checks.
- The exact inspected host must load the supplied JSON configurations, not merely expose variables or use legacy fallback.
- Effective config version, provider and fingerprint mismatches have distinct blocker codes.
- Provider/root collision is checked across the actual effective host pair. An offline valid pair does not override a collision in the host environment.
- Trust-ledger high-water, rotation/revocation continuity and external monotonic checkpoint CAS remain separate gates; `/proc` inspection does not prove them.

## Producer-to-dispatch invariant

1. Real producers emit typed durable artifacts with producer/result/attempt/completion lineage.
2. A separately administered verifier authenticates the exact current Goal/Idea snapshot and evidence manifest.
3. Every Plan Graph step has validated supporting evidence and binds to the authenticated snapshot.
4. Reviewer identity/approval is independently verified, scope-bound, fresh, replay-resistant and pinned to the immutable plan hash.
5. Execution Graph proposals persist and read back against the exact plan, evidence lineage, snapshot and approval.
6. Dispatch rechecks current state, replay, revocation, idempotency and fencing immediately before side effects.

The isolated producer → nine-step Plan Graph → persisted Execution Graph E2E and negative controls are local implementation tests with test-local trust. They do not constitute production approval or dispatch authorization.

## Current acceptance findings

The direct read-only snapshot readback still has an empty evidence manifest, `verified=false` and `eligibleForAttestation=false`. The current reconciliation reports 4 historical planner source-hash mismatches, 22 Plan Graph steps missing supporting evidence, 3 proposals missing authenticated snapshot binding, and 0 persisted Execution Graph proposals. Preserve historical rows and hashes; only real producer evidence plus independent verifier authority can resolve these findings.

The workflow DB currently reports 60 job-level reconciliation candidates and 61 running tasks without active lease rows. These are different entity counts. No aggregate finding proves a worker is dead or a job/task is terminal. Owner/provider/runtime evidence and authorized per-record disposition are required.

RC.52 acceptance and source-alignment checks pass, but rollout preflight remains `BLOCKED`, `canActivateNow=false`, with all six RC.47 authority blockers open. Neither local hashes, generated docs parity nor test-local trust can substitute for Phase 2 custody, authenticated release provenance, production trust, external checkpoint continuity or verified workflow/task drain.
