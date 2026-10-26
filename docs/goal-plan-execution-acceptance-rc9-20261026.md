# Goal/Idea → Plan → Execution Graph acceptance — RC.9 successor

Generated: 2026-10-26 (UTC evidence timestamps are recorded in the linked reports)

**Decision: BLOCKED. Production three-graph E2E: NOT VERIFIED. Activation is not authorized.** This release candidate fixes a reviewer anti-rollback database-boundary flaw and uses a new version/generation rather than trying to reinstall RC.8. All execution evidence described below is offline or read-only; isolated E2E dispatch is confined to disposable test state.

## Candidate and recovery baseline

- Candidate: `artifacts/mcpb-candidate-build-20261026T1615+0700/runalith-1.0.9-rc.9-goal-plan-execution-reviewer-ledger-hardening.mcpb`
- Version / entry point: `1.0.9-rc.9` / `server/index-v1.0.9-rc.9.js`
- SHA-256: `b78fb18f4593103dc1574b15bff0ec6e5eb11f60276a4b802acf3aff690d2db7` (806,228 bytes; 93 archive entries; 74 manifest/runtime tools)
- Source snapshot SHA-256 from alignment check: `08bcef086d7514ce4d0f7ee7de110c172e48728f63d8789c2fbb3306c0c48fa2`
- Source-to-bundle alignment: PASS; archive integrity, extracted mandatory regressions and MCP fast test: PASS.
- Rollback baseline: `/tmp/runalith-1.0.9-rc.8-current-installed-baseline-rollback-20261026T1508Z.mcpb`, SHA-256 `9ad23a622967f3a2fe2117511ab86c2d3036bd14630cfaee144a44cedec2d803`. It is a content-derived snapshot with file parity and isolated smoke evidence, not the original publisher archive or a publisher signature/attestation.
- Candidate has **not** been installed or activated. `verify-installed` intentionally reports mismatch because the host still serves RC.8 and its installed dependency/test bytes differ from this RC.9 candidate. No registry/configuration edit or host restart occurred.

## Implementation and contract changes

- Reviewer anti-rollback now requires a configured dedicated trust-ledger connection and rejects an absent ledger, a connection already in a transaction, or an alias of the workflow database. It no longer falls back to `store.db`; regression checks prove no trust-history table is silently created in workflow storage.
- The new regression is included in the archive and is actually run against extracted candidate bytes.
- Version metadata, manifest, lockfile and entry point were advanced to RC.9. This addresses the v18 `CANDIDATE_VERSION_ALREADY_INSTALLED` gate by creating a real successor; it does not imply installation or activation.
- Benchmark provenance v19 is a successor to v18 and refreshes only reviewed source pins. Historical fixtures v14–v18 remain byte-for-byte unchanged.
- The broader pipeline E2E verifies typed producer artifacts, Goal/Idea snapshot attestation, nine-node Plan Graph dependency preservation, readiness/evidence lineage, Execution Graph proposal, reviewer identity, exact immutable plan binding, and isolated lifecycle progression. Test keys and dispatch are disposable/test-only and are not production trust evidence.

## Validation evidence

| Check | Result | Evidence |
|---|---|---|
| Full `npm test` | PASS, exit 0 | `artifacts/adaptive-goal-graph/final-verification-20261026T1615+0700-npm-test.log` |
| Trust configuration, verifier, reviewer, producer-to-three-graph disposable DB E2E | PASS, 27/27 | `artifacts/adaptive-goal-graph/final-verification-20261026T1615+0700-trust-e2e.log` |
| Reviewer anti-rollback negative regression | PASS, 7/7 reviewer tests | Included in trust E2E log and extracted-package test output |
| Benchmark adversarial/provenance suite | PASS, 14/14 | `artifacts/adaptive-goal-graph/final-verification-20261026T1615+0700-benchmark-v19.log` |
| Package reproducibility | PASS; independent builds bit-for-bit identical | `artifacts/adaptive-goal-graph/final-verification-20261026T1615+0700-package-reproducibility.log` |
| Source-to-bundle alignment | PASS; 93 entries, 74 tools | `artifacts/adaptive-goal-graph/source-alignment-20261026T1615+0700-rc9.log` |
| MCP candidate fast test / extracted package regressions | PASS | `artifacts/adaptive-goal-graph/final-verification-20261026T1615+0700-mcpb-fast-test.log` and candidate build output |
| Documentation/link checks | PASS; 334 Markdown files and 278 local links expected after this page is included | `artifacts/adaptive-goal-graph/final-verification-20261026T1615+0700-docs-check.log` (rerun after final doc synchronization) |
| `git diff --check` | PASS before this acceptance page; rerun after final synchronization | `artifacts/adaptive-goal-graph/final-verification-20261026T1615+0700-git-diff-check.log` |
| ZIP integrity | PASS; no compressed-entry errors | `unzip -t` of the candidate archive |

The benchmark v19 SHA-256 is `9122ab7c84166eac6b150dae9192414a3a2498945bd9a852baed37ed91edc613`. Historical fixture hashes v14–v18 remain unchanged; their hashes are preserved in the machine-readable dossier.

## Read-only live observations

- Latest read-only reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-20261026T1615+0700-rc9.json`, generated `2026-10-26T08:54:56.965Z`.
- Counts: 136 jobs, 5,304 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 118 approvals and **0 lease rows**.
- Of 84 considered active jobs: 60 are `EXECUTING` with 61 running tasks and no active leases; 6 await dispatch; 18 await proposal/approval. Owner/provider identity is not authoritatively persisted for the flagged cases, and execution/runtime observations do not establish that a worker is dead.
- No bulk reset, terminalization, retry, redispatch or live workflow DB mutation was performed.
- Fresh preflight: `artifacts/adaptive-goal-graph/rollout-preflight-current-rc9-20261026T1615+0700.json`, exit 3, `BLOCKED`, `readOnly=true`, `liveMutationPerformed=false`.

## Remaining blockers and authority-owned remediation

1. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: the host administrator/security authority must provision the exact `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` values using independently administered providers, different Ed25519 public roots, exact scopes, auditable config versions and controlled key lifecycle. See [trust provisioning runbook](agg-production-trust-provisioning-runbook.md). No roots or signatures were generated for production.
2. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: a host-owned cryptographic verifier and independently protected monotonic checkpoint store must verify checkpoint signature, authority identity, chain continuity, anti-rollback sequence and exact candidate/rollback hashes. Self-asserted JSON flags and local SQLite history cannot satisfy this gate.
3. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` and `RUNNING_TASKS_MUST_DRAIN`: each flagged job/task must be correlated by its owner against current host/provider identity, runtime process identity, event, attempt, result, artifact, owner and lease evidence. Missing leases or age alone never authorize lifecycle changes. Reconcile each case under documented owner authority, then collect a fresh read-only report.
4. `CANDIDATE_VERSION_ALREADY_INSTALLED` from v18 is addressed only at the candidate identity level by RC.9. The currently installed generation remains RC.8 and differs from this candidate; installation/activation is still not authorized until the other gates clear.

**Production readiness remains BLOCKED.** Offline tests establish software behavior only in disposable state; read-only live observations establish current stored/runtime signals only. Neither proves live production claim truth, independently administered trust, reviewer authorization, external anti-rollback, workflow drain, or a successful production Goal → Plan → Execution Graph run.

Machine-readable dossier: `artifacts/adaptive-goal-graph/acceptance-dossier-20261026T1615+0700-rc9.json`.
