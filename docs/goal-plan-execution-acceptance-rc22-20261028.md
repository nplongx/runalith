# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.22

## Decision

**SUPERSEDED before final acceptance by RC.23. Production readiness: BLOCKED.** RC.22 introduced the explicit opt-in, redacted-by-default source mismatch diagnostics. A subsequent review found that the first build did not consistently populate the expected digest from the historical URI when `details_json` omitted it. The correction and regression are carried by RC.23; do not treat the first RC.22 archive as the final accepted candidate.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.22-actionable-source-mismatch-recovery-20261028.mcpb`
- Superseded archive SHA-256: `ebee840aabaf97ca98d09f736b660a3300912549e80cf2645d915ab9a9ec5189`; size 852,309 bytes; 93 archive entries; 74 tools. Source-alignment report at build time used source snapshot `70c6aea8024bbb1f7a31b953f63f83f219a7075f972c69f561bdc8651b370bcc` and did not include the later expected-digest correction.
- Package/manifest version: `1.0.9-rc.22`; entrypoint `server/index-v1.0.9-rc.22.js`, byte-identical to RC.21 runtime entrypoint.
- Benchmark successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v64.json`. RC.21 fixture v63 and all earlier fixtures are immutable.

## RC.22 implementation change

`scripts/reconcile-active-workflows.mjs` supports `--include-sensitive-source-identifiers`. The default remains redacted and includes only `evidenceReferenceSha256`. Explicit opt-in adds the historical `file:` URI, expected SHA-256, observed SHA-256 and source resolver classification for each planner source-evidence row. Report policy records whether sensitive identifiers were included. The report is still read-only and never updates source rows, expected digests, evidence, graph snapshots, proposals or lifecycle state.

The new regression proves that default output omits the URI, while explicit opt-in returns the exact mismatch and both digests; claim truth and independence remain false. The runbook instructs operators to keep such output in access-controlled storage and to retain mismatches in historical rows. If a source is no longer byte-identical, create new evidence only through an authorized producer path after confirming the current source supports the same claim.

## Acceptance boundary

- Targeted reconciliation tests pass, including default redaction and explicit actionable-source mode.
- Benchmark v64 validates current source pins while preserving the frozen graph/task IDs and ground-truth oracle; v63 and earlier fixture bytes remain unchanged.
- RC.22 full `npm test` passed, log `/tmp/runalith-npm-test-rc22-actionable-source-mismatch-recovery-20261028.log`, SHA-256 `71d9dc4a931a1394f53060675d9b5ef5124fe6a611bd9bddb0e033bc64882f7e`.
- RC.22 package reproducibility and MCPB fast test passed; archive ZIP integrity passed. This evidence is retained historically but does not supersede the RC.23 source correction.
- Local signature verification with test keys, source byte integrity and internal graph hashes do not establish independent verifier/reviewer authority.

## Live state and blockers

The fresh read-only RC.22 report identified four source-hash mismatch findings spanning eight planner evidence rows, including three historical URIs for `src/runtime/adaptive-goal-execution-readiness.js`, plus references to `docs/adaptive-goal-graph.md`, `docs/agg-phase1-benchmark-methodology.md`, `tests/test-adaptive-goal-compatibility.js`, and `tests/test-adaptive-goal-execution-readiness.js`. The RC.23 correction makes expected digests from the URI available when `details_json` has no digest. No historical rows were changed.

The six host-managed gates remain open:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — owner-signed canonical manifest of exactly 71 sorted unique portable paths, exact controlled-builder receipt and host-pinned distinct authority/builder roots.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — independently signed provenance, verification envelope and approval bound to candidate, baseline, rollback and host-issued single-use nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — independently administered versioned verifier/reviewer JSON, distinct provider IDs, disjoint Ed25519 SPKI roots, scopes, effective runtime verification and anti-rollback.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — host-owned adapter, independently protected monotonic store, signed continuity, nonce consumption and CAS receipt.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — per-job owner/provider/runtime and durable event/attempt/result/artifact/lease reconciliation.
6. `RUNNING_TASKS_MUST_DRAIN` — per-task completion and artifact lineage, runtime/provider state and authoritative lease/owner epoch.

No live graph/workflow DB, host config/registry, host process, external checkpoint or production lifecycle is changed by this candidate work. Keep rollout `BLOCKED` until independent authorities close all gates.
