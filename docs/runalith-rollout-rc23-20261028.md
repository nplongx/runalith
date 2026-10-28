# Runalith RC.23 rollout dossier — 2026-10-28

## Decision

**BLOCKED — do not activate or dispatch production workflows.** RC.23 corrects the expected-digest extraction in the opt-in read-only historical source-mismatch diagnostic. It is a distinct version because the corrected tool/test is included in the candidate archive; runtime entrypoint bytes are unchanged from RC.22.

## Candidate and validation

- Candidate: `dist/runalith-1.0.9-rc.23-actionable-source-mismatch-recovery-20261028.mcpb`
- Version/entrypoint: `1.0.9-rc.23` / `server/index-v1.0.9-rc.23.js`.
- SHA-256: `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; size 852,332 bytes; 93 entries; 74 tools.
- Source snapshot SHA-256: `1c672a712e0dff91302031cd9d5fbefb778ede99384fff93da1dcdf0dcb281ec`.
- Source alignment: `/tmp/runalith-source-alignment-rc23-actionable-source-mismatch-recovery-20261028.json`, SHA-256 `17be9cf8f152dbb763e4c380e0d862d393ce941d0afc0543ec7cf58d1fdb2467`; byte alignment PASS, authenticated provenance NOT VERIFIED.
- Full `npm test`: exit 0; log SHA-256 `51f285013f25dbc4bfe6c320bd003bfdfa5559d38a097cb0c1126a5fba9a86c2`.
- Package reproducibility: PASS; MCP fast test `MCPB_FAST_TEST=PASS`; ZIP integrity PASS.
- Benchmark successor v65: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v65.json`; v64 and earlier fixtures remain unchanged.

## Safe historical-source recovery

Routine reports redact source references. An authorized operator may opt in to exact source identifiers with `--include-sensitive-source-identifiers`; use a new `--out` path in access-controlled storage. The report includes the historical URI, expected and observed SHA-256, and resolver classification. It is read-only. Never rewrite a historical reference/hash to clear a blocker; produce a new evidence record through the approved producer path only after the owner confirms claim relevance.

Fresh live reconciliation: `/tmp/runalith-live-reconcile-rc23-sensitive-source-mismatch-20261028.json`, SHA-256 `fca4f8262a230ca923901000166c346e4eab9092f1ec349483ae0cda9ce777ec`, mode `0600`. Fresh preflight: `/tmp/runalith-preflight-rc23-actionable-source-mismatch-recovery-20261028.json`, SHA-256 `49d2173ffcaca7bf90bb7beb3fa3a6a58f51f6e1a45bd218eeeaa9364ab0db4e`; exit code `3`, `BLOCKED`, `canActivateNow=false`, read-only, no checkpoint transition.

## Unresolved gates

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: Phase 2 contract owner supplies the canonical owner-signed manifest with exactly 71 sorted unique portable paths; controlled builder signs exact-candidate/source/tree receipt; platform security pins distinct authority/builder SPKI roots. Do not trim a 93-entry archive.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: independent release authority supplies signed builder provenance, verification envelope and approval bound to candidate/baseline/rollback digests and a host-issued single-use nonce.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: verifier and reviewer administrators separately provision versioned public-only JSON configs, distinct provider IDs, disjoint Ed25519 SPKI roots/scopes, effective runtime status and anti-rollback evidence.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: platform security provisions the host-owned authenticated adapter and independently protected monotonic store; require fresh signed continuity, nonce consumption and CAS commit receipt.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`: workflow owners/provider/runtime operators reconcile each job's events, attempts, results, artifacts, owner/provider/runtime and leases before any disposition.
6. `RUNNING_TASKS_MUST_DRAIN`: reconcile each running task's attempt/completion/artifact lineage, provider execution state and authoritative lease/owner epoch. Missing lease does not prove worker death.

No live DB write, graph mutation, host config/registry edit, process restart/kill, package activation, checkpoint transition or production dispatch is permitted by this work. Do not claim READY until independent evidence closes every gate.
