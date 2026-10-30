# Goal/Plan/Execution Graph acceptance — RC.50 — 2026-10-29

## Scope

RC.50 improves operator-side trust-domain diagnostics and strengthens source-alignment inventory completeness. The runtime dispatch implementation is byte-identical to the prior versioned runtime; this release does not claim to close the Goal/Idea → Plan → Execution evidence chain in production.

The direct read-only snapshot re-read returned `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`, with 7 nodes, 7 edges, 7 memberships and an empty evidence manifest. It is not verified and is not eligible for attestation. The latest graph reconciliation still reports 4 historical planner source-hash mismatches, 22 Plan Graph steps without supporting evidence, 3 proposals without authenticated current-snapshot binding and 0 persisted Execution Graph proposals. Historical source hashes must not be rewritten to suppress these findings.

## Trust preflight behavior

The operator validator now distinguishes:

- missing config file vs absent/blank host JSON config;
- invalid schema vs invalid schema/config version;
- expected file not loaded by the host vs effective version/provider/fingerprint mismatch;
- verifier/reviewer provider collision vs canonical SPKI root collision;
- a supplied valid pair vs a valid pair actually loaded by the exact inspected host process.

Effective host validation checks the loaded verifier/reviewer pair itself, not just whether each domain individually matches a supplied file. Tests cover a pair whose input files are disjoint but whose observed host environment has a shared root; it must return `AGG_TRUST_DOMAINS_ROOT_COLLISION` and exit 3. This is still a local `/proc` inspection, not a signed host attestation. Trust-ledger high-water and external checkpoint continuity remain separate gates.

## Producer-to-dispatch invariant

1. Real producers must emit typed, durable artifacts with producer/result/attempt/completion lineage.
2. A separately administered verifier must authenticate the exact current Goal/Idea snapshot and evidence manifest.
3. Each Plan Graph step must have validated supporting evidence and bind to that authenticated snapshot.
4. Reviewer identity and approval must be independently verified, scoped and pinned to the immutable plan hash.
5. Execution Graph proposal must persist and read back against the exact Plan Graph, evidence lineage, snapshot and approval.
6. Dispatch must recheck freshness, replay, revocation, idempotency and fencing immediately before any side effect.

The isolated producer-to-nine-node Plan Graph-to-Execution Graph E2E and its negative controls are implementation tests only. They use test-local trust and isolated databases; they do not establish production trust, owner approval or dispatch authorization.

## Acceptance status

The candidate source alignment and MCP fast test pass. The preflight remains `BLOCKED`, `canActivateNow=false`, with all six RC.47 authority gates open. The current workflow database has 60 job candidates and 61 running tasks without active lease rows; all remain unresolved until owner/provider/runtime evidence and authorized disposition are supplied. No test, hash or local snapshot integrity check can close those gates.
