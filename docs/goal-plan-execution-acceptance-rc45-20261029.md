# Goal / Plan / Execution Graph acceptance — RC.45

**Scope:** local implementation acceptance for RC.45. This document is not production trust, an authenticated build receipt, release approval, or activation authorization.

## Integrated acceptance coverage

- Typed producer artifacts retain exact result/attempt/event/artifact lineage; malformed, missing, stale or unregistered evidence fails closed.
- Goal/Idea snapshots bind canonical graph identity, revisions, memberships, edges, evidence manifest and configured signer trust. Structural/hash integrity does not prove claim truth or independent provenance.
- Plan Graph proposals require authenticated current-snapshot bindings, supported evidence for each step, valid source lineage and immutable plan hashes.
- Execution Graph proposals are persisted/read back in isolated E2E and cross-bound to source Plan proposal fingerprints and exact step/task bindings. Internal hashes do not establish reviewer authority.
- Reviewer attestations enforce configured trust roots, exact scope/candidate/plan, expiry, revocation and one-use nonce semantics. Dispatcher revalidates freshness and authorization before external effects.
- Workflow recovery remains fail-closed for quarantined uncertain provider effects, active native runtime records and legacy provider-run schema ambiguity.
- Read-only reconciliation emits per-record lineage and remediation evidence. No lifecycle mutation or terminal disposition is inferred from stale age or missing lease.
- Trust-config acceptance covers exact schema/version, provider separation, canonical SPKI root collision, scope, validity, rotation/revocation and anti-rollback; effective host environment inspection remains distinct from production authority and external anchor verification.
- Benchmark fixture v86 pins the corrected source-alignment input set. Historical fixtures v82-v85 remain immutable; hashes identify bytes only.

## Validation results

- Full `npm test`: exit `0` after RC.45 changes.
- Focused benchmark/source-alignment/Phase 1 evidence-pack tests: 20/20 passed.
- Extracted package mandatory tests and local MCP E2E: passed during RC.45 build.
- Candidate MCP fast test: `MCPB_FAST_TEST=PASS`, 74/74 manifest/runtime tools, `ok/local-only-mcp`.
- Package no-overwrite and two-build reproducibility checks: exit `0`.
- Archive integrity: 103 entries, no duplicate names.
- Final `npm run docs:check`, `git diff --check` and source-alignment report are generated separately after handoff documents are written.

## Live-state acceptance is not satisfied

Latest read-only reports show 86 jobs requiring per-record classification, 60 stale candidates, 61 running tasks without active lease rows, 0 verified terminal dispositions, four historical planner source-hash mismatches, 22 Plan Graph steps without supporting evidence, three proposals without authenticated snapshot binding, and zero persisted Execution Graph proposals. These counts are timestamped observations, not assumptions of failure or permission to repair. Owner/provider/runtime evidence is required for every disposition.

## Release decision: BLOCKED

All six blockers remain open: frozen Phase 2 71-path custody contract; independent release evidence; production AGG trust configuration; external monotonic ledger anchor; active workflow drain; running-task drain. No authenticated builder receipt or independent release evidence exists for RC.45. No production install, activation, dispatch, workflow DB mutation, host config mutation, trust-ledger mutation or checkpoint transition occurred.
