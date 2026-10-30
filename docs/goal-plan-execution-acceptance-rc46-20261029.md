# Goal / Plan / Execution Graph acceptance — RC.46

**Local implementation acceptance only. This document is not production trust, an authenticated build receipt, release approval, or activation authorization.**

## Cross-graph invariants

- Goal/Idea graph integrity hashes nodes, revisions, memberships, edges and evidence manifest. A canonical hash or stored binding does not establish signer identity, provenance, claim truth or independence.
- Typed producer artifacts must bind exact bytes, schema, producer identity, job/task, attempt, result and completion/event lineage. Missing, invalid, stale, unregistered or substituted evidence is rejected.
- Plan Graph proposals must bind an authenticated current Goal/Idea snapshot, complete per-step supporting evidence and valid source lineage. The plan hash is immutable once approved.
- Execution Graph proposals persist and revalidate their source Plan proposal, exact task/step mapping, snapshot identity and immutable plan hash. Internal fingerprints are consistency checks, not authenticity or authority.
- Reviewer approval requires a configured trusted identity, exact scope and candidate/plan binding, freshness, non-revoked key and anti-replay nonce. Dispatch revalidates approval and current plan/snapshot before side effects.
- Recovery and terminalization fail closed for quarantined uncertain provider effects, active native runtime records, stale leases and ambiguous legacy provider-run schemas. Missing lease is not proof of worker death.
- Verifier/reviewer trust configs enforce strict schema/version, provider separation, disjoint canonical SPKI roots, scope, key validity, rotation/revocation and local anti-rollback. Effective process configuration, active ledger consistency and external monotonic anchor are separate gates.
- Benchmark fixture v87 pins the updated source-alignment inputs and regenerated MCP reference. Fixtures v82-v86 remain byte-for-byte unchanged; hashes identify bytes only.

## Validation

- Full `npm test`: exit `0`.
- Focused benchmark, source-alignment, Phase 1 evidence-pack and package-boundary tests: 20/20 passed.
- RC.46 extracted package acceptance and local E2E passed during package build.
- Candidate MCP fast test passed with 74/74 manifest/runtime tools and `ok/local-only-mcp`.
- Package no-overwrite and reproducibility checks exited `0`.
- ZIP integrity passed: 103 unique entries.
- `npm run docs:check` passed after reference regeneration; final handoff-inclusive count is checked separately.

## Live acceptance remains blocked

Fresh read-only reports observe 86 jobs, 60 stale candidates, 61 running tasks without active lease rows, 0 verified terminal dispositions, four historical planner source mismatches, 22 Plan Graph steps without evidence, three proposals without authenticated snapshot binding and zero persisted Execution Graph proposals. These are current local observations, not proof of failure or permission to repair. Reconcile each record with its owner and authoritative provider/runtime evidence.

## Release decision

All six blockers remain open: Phase 2 Frozen 71-path custody contract, independent release evidence, production AGG trust configuration, external monotonic ledger anchor, active workflow drain and running-task drain. RC.46 has no authenticated builder receipt. No production installation, activation, workflow DB mutation, host config mutation, trust-ledger mutation, checkpoint transition or production dispatch occurred.
