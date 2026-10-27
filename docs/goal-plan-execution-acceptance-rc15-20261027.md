# Runalith 1.0.9-rc.15 — Goal/Plan/Execution Graph acceptance status

Date: 2026-10-27. This document records local acceptance evidence only; it is not a release approval or host authorization.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.15-candidate-20261027T1635.mcpb`
- Version / entry point: `1.0.9-rc.15` / `server/index-v1.0.9-rc.15.js`
- Candidate SHA-256: `f11e0303c0929f6d145f53f2033ce8195c2da6e9061bde1372ce6d19706091d1`
- Size: 838,310 bytes; ZIP entries: 93; manifest tools: 74
- Source-to-bundle snapshot SHA-256: `17603321cfa55f248dc29d6d82a57ddb2164cb51897d1984483019a486f73a85`
- Source alignment report: `/tmp/runalith-alignment-rc15-final4-20261027.json` (SHA-256 `7e463eff1e5278406b9e99e179169e68d66cd424c68bff587d3c8b87c80f570b`).
- Source snapshot SHA-256: `17603321cfa55f248dc29d6d82a57ddb2164cb51897d1984483019a486f73a85`.
- Packaging log: `/tmp/runalith-pack-rc15-20261027.log`
- Fresh rollout preflight: `/tmp/runalith-preflight-rc15-final-20261027.json` (SHA-256 `268771fcec45074cd6b668c742f912c26d630882823da1609b5dd951f3c87209`; exit 3, read-only, `canActivateNow=false`).

The packaging pipeline verified exact archive-entry bytes against the current source and exercised the extracted runtime, schema contracts, trust regressions, and Goal → Plan → Execution Graph E2E in a disposable database. The source worktree is dirty and no authenticated builder receipt is present; therefore source alignment is not proof of authenticated build provenance.

## Local validation

- `npm test`: PASS; `/tmp/runalith-npm-test-rc15-final2-20261027.log`.
- Focused trust/release/checkpoint/custody: PASS 66/66; `/tmp/runalith-focused-trust-rc15-final-20261027.log`.
- Goal/Plan/Execution E2E, proposal and evidence lineage: PASS 23/23; `/tmp/runalith-agg-e2e-rc15-final-20261027.log`.
- Benchmark v46 regression: PASS 15/15; `/tmp/runalith-benchmark-rc15-focused-final-20261027.log`.
- `npm run docs:generate-reference`: PASS; `/tmp/runalith-docs-generate-rc15-20261027.log`.
- `npm run docs:check`: PASS; `/tmp/runalith-docs-check-rc15-final2-20261027.log`.
- `npm run site:check`: PASS; `/tmp/runalith-site-check-rc15-final2-20261027.log`.
- `npm run test:phase2-security-regressions`: PASS; `/tmp/runalith-phase2-security-rc15-retest-20261027.log`.
- `npm run test:phase2-custody`: PASS 5/5; `/tmp/runalith-phase2-custody-rc15-final-20261027.log`.
- MCP fast test: PASS, 74/74 tools; `/tmp/runalith-mcpb-fast-rc15-final2-20261027.log`.
- ZIP integrity: PASS; `/tmp/runalith-zip-integrity-rc15-final-20261027.log`.
- `git diff --check`: PASS; `/tmp/runalith-diff-check-rc15-final2-20261027.log`.
- Fresh source-to-bundle alignment reports 92 exact source-byte entries plus one exact projected package-metadata entry across all 93 ZIP entries. Build provenance remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; the release eligibility field is blocked by design.

The Phase 2 inventory regression now reports the actual condition without pretending it passed release acceptance: the exact source-aligned successor has 93 ZIP entries while the frozen Phase 2 contract requires 71. It remains `candidate-unapproved-review-evidence-only`; the contract was not changed and the package was not trimmed. See `/tmp/runalith-phase2-security-rc15-retest-20261027.log` for the explicit `frozen_inventory_count_mismatch` diagnosis.

The benchmark fixture v46 supersedes v45 and updates exact source pins for RC.15. The v41–v45 fixtures and all older historical fixtures remain unchanged. The ground-truth oracle, task graph, evidence requirements and scoring contract are unchanged.

## Live workflow safety

The latest read-only reconciliation is documented in the RC.13 historical acceptance dossier and reports under `/tmp/runalith-live-reconciliation-*v45-20261027.json`. It observed 60 stale-candidate jobs and 61 running tasks without active lease rows, incomplete authoritative owner/provider/runtime identity, Goal/Idea without trusted attestations, Plan Graph steps without supporting evidence and no persisted Execution Graph proposal. These observations do not prove workers are dead. No bulk reset, retry, terminalization, dispatch or live DB write is authorized by these reports.

## Release decision

**BLOCKED — not production-ready.** Local tests and source-to-bundle alignment do not establish independent release evidence, host-managed trust configuration, an external monotonic trust-ledger checkpoint or authoritative runtime drain.

The fresh preflight verifies the RC.15 candidate and RC.11 rollback snapshot, but still returns exit code 3 with these five blockers: `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`, `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`, and `RUNNING_TASKS_MUST_DRAIN`. The rollback snapshot hash is `ded039f0c611177d43deacc15df181165524b7a3376ed24794a7096aee0876e3`; the candidate hash above is the exact digest checked by preflight.

Remaining owner evidence:

1. **Artifact/release authority:** signed provenance from the controlled builder, signed independent verification predicate, release approval and host-issued single-use nonce bound to the exact candidate, source snapshot, installed baseline and rollback bytes.
2. **Platform/security owner:** independently provisioned versioned verifier and reviewer JSON configs, distinct provider identities and disjoint trust roots, effective-config attestation from the host-owned runtime, rotation/revocation records, and an authenticated external monotonic checkpoint proving sequence, previous digest, ledger digest, candidate and rollback binding.
3. **Workflow/task owners and provider/runtime operator:** authoritative per-job/per-task owner, provider run/session ID, runtime process identity, lease/heartbeat or provider status, and exact event/attempt/result/artifact hashes plus completion evidence. Resolve one record at a time; keep unknown states on hold.
4. **Phase 2/artifact owner:** authoritative signed 71-path manifest, canonical source snapshot/commit and authenticated builder receipt. The frozen contract is 71 paths; do not infer the path list from its count or trim the 93-entry candidate to fit.

No production package install/activation, plugin registry/config mutation, host restart/kill, live workflow DB write, production dispatch, stage, commit, push, tag or publication occurred.
