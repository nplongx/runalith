# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.27

**Decision: `BLOCKED` for production.** RC.27 adds a tested, machine-readable readiness dossier compiler and binds its implementation and negative tests into the source snapshot. The Goal/Idea Graph runtime, Plan Graph, Execution Graph and trust implementation are carried forward from RC.26 without a new production-trust claim. This is a versioned candidate, not an activation authorization.

## Acceptance invariants

1. A well-formed graph hash is not a claim-truth attestation. Current snapshot evidence references and manifest must resolve to durable producer-bound `artifact://` evidence before attestation.
2. A self-asserted `verified`, isolated test identity, environment variable, local ledger or matching hash cannot establish production trust.
3. Plan Graph steps require complete typed supporting evidence and current authenticated snapshot binding. Execution Graph proposals remain review-only until the source plan, evidence, reviewer identity, immutable plan pinning and approval lifecycle all revalidate.
4. Source hash mismatches remain findings against immutable historical records. Their exact cause is not assumed; historical digests are never rewritten to clear a finding.
5. Missing worker PID, provider identity, lease or recent activity is not proof a worker died. Reconciliation only proposes `HOLD_FOR_OWNER_RECONCILIATION` and grants no lifecycle authority.
6. All six RC.23 gates remain open unless an authority-appropriate, exact-candidate-bound evidence chain is independently verified. A missing finding or a local test pass cannot close a gate.

## New acceptance automation

`scripts/build-agg-readiness-dossier.mjs` composes current source alignment, live reconciliation, rollout preflight, dedicated Goal/Idea snapshot and effective trust-status observations. It rejects candidate digest disagreement, non-read-only inputs, or an input snapshot that claims promotion without evidence eligibility. Its tests cover all six RC.23 gates, source-hash mismatch, 22 missing Plan Graph step evidence, absent Execution Graph proposals, both missing trust domains, missing leases and candidate identity mismatch.

The dossier records source file paths and SHA-256 hashes for every input report, exact candidate identity, current graph snapshot hash, proposal/evidence counts, source-mismatch record IDs, record-level workflow recovery identities, owner/provider/runtime/lease uncertainty, and the specific authority action and post-repair verification needed for each gate. It is an evidence index, not a signature or independent authority receipt.

## Observed live state used for this acceptance cycle

The latest current-scope snapshot observation returned:

- Goal ID: `runalith-agg-e2e-20261026-clean`.
- Snapshot hash: `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`.
- 7 nodes, 7 edges, 7 memberships; integrity valid; 0 evidence references.
- Evidence manifest hash: `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`; attestation eligibility is false.
- `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` is blank and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` is blank in the effective runtime. Both trust domains report unavailable and no roots.
- Read-only reconciliation reports 4 current source-hash mismatch findings, 65 planner runs, 373 planner evidence records and zero verified claims; 3 Plan Graph proposals, 22 observed steps, all 22 missing supporting evidence, 3 without authenticated snapshot binding, and 0 persisted Execution Graph proposals.
- The live workflow DB has 138 jobs, 1,277 tasks, 5,309 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and zero lease rows. The current selected inventory reports 60 executing jobs and 61 running tasks without active leases; authoritative worker/provider outcome is unresolved.

These values are observations captured during the RC.26 preflight window. The generated RC.27 dossier must carry fresh reports and hashes; it must not silently treat this text or earlier reports as current forever.

## External dependencies required for closure

- **Phase 2 contract owner / controlled builder / platform security:** signed canonical 71-path manifest, exact candidate-bound builder receipt and host-pinned authority policy.
- **Independent release authority:** trusted builder provenance, independent verification, release approval and host-issued nonce bound to exact candidate, installed baseline and rollback.
- **Host/security administrator + two independent trust authorities:** valid versioned verifier/reviewer JSON configs, distinct provider IDs and disjoint Ed25519 roots, effective runtime configuration and matching versioned append-only trust ledger records.
- **External checkpoint authority:** root-pinned host adapter/policy, independently protected monotonic store, separate store-attestation root and fresh signed continuity/CAS receipts.
- **Workflow/task owners and provider/runtime operators:** authoritative record-by-record disposition of all executing jobs and running tasks. Missing leases are not a death signal and no bulk lifecycle transition is permitted.

See [RC.27 rollout dossier](runalith-rollout-rc27-20261028.md) and [production trust provisioning runbook](agg-production-trust-provisioning-runbook.md) for the re-runnable verification path.

## Validation decision

Acceptance is conditional on the generated candidate-bound evidence artifacts for full `npm test`, focused dossier/trust/E2E/negative suites, archive integrity, 74/74 manifest/runtime tool parity, source-to-bundle alignment, package reproducibility, docs/link checks, `git diff --check`, and read-only rollout preflight. Results must be reported with exact commands, exit codes, artifact paths and hashes. The production decision remains `BLOCKED` if any of the six external/live gates remain unresolved.
