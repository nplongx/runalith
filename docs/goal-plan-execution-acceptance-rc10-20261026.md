# Goal/Idea → Plan → Execution Graph acceptance — RC.10 successor

Generated: 2026-10-26 (UTC evidence timestamps are recorded in the linked reports)

**Decision: BLOCKED. Production three-graph E2E: NOT VERIFIED. Activation is not authorized.** This release candidate fixes both reviewer anti-rollback verification and diagnostics, and uses a new version/generation rather than trying to reinstall RC.8 or RC.9. All execution evidence described below is offline or read-only; isolated E2E dispatch is confined to disposable test state.

## Candidate and recovery baseline

- Candidate: `artifacts/mcpb-candidate-build-20261026T1630+0700/runalith-1.0.9-rc.10-goal-plan-execution-reviewer-ledger-status-hardening-v20.mcpb`
- Version / entry point: `1.0.9-rc.10` / `server/index-v1.0.9-rc.10.js`
- SHA-256: `cdb04137a0e116943cbf23059b81818cf803f188c3a1309b69939cce957a1e36` (806,395 bytes; 93 archive entries; 74 manifest/runtime tools)
- Source snapshot SHA-256 from alignment check: `06261bad5db610b5192eb0488fea84de8c9af004bce553e02e2f0168aa5f6040`
- Source-to-bundle alignment: PASS; archive integrity, extracted mandatory regressions and MCP fast test: PASS.
- Rollback baseline: `/tmp/runalith-1.0.9-rc.8-current-installed-baseline-rollback-20261026T1508Z.mcpb`, SHA-256 `9ad23a622967f3a2fe2117511ab86c2d3036bd14630cfaee144a44cedec2d803`. It is a content-derived snapshot with file parity and isolated smoke evidence, not the original publisher archive or a publisher signature/attestation.
- Candidate has **not** been installed or activated. `verify-installed` intentionally reports mismatch because the host still serves RC.8 and its installed dependency/test bytes differ from this RC.10 candidate. No registry/configuration edit or host restart occurred.

## Implementation and contract changes

- Reviewer anti-rollback now requires a configured dedicated trust-ledger connection and rejects an absent ledger, a connection already in a transaction, or an alias of the workflow database. It no longer falls back to `store.db`; regression checks prove no trust-history table is silently created in workflow storage.
- The new regression is included in the archive and is actually run against extracted candidate bytes. A separate negative regression confirms reviewer configuration diagnostics return `available: false` and `AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE` when the anti-rollback ledger is absent.
- Version metadata, manifest, lockfile and entry point were advanced to RC.10. This is a distinct successor to the previously built RC.9 and does not imply installation or activation.
- Benchmark provenance v20 is a successor to v19 and refreshes only reviewed source pins. Historical fixtures v14–v19 remain byte-for-byte unchanged.
- The broader pipeline E2E verifies typed producer artifacts, Goal/Idea snapshot attestation, nine-node Plan Graph dependency preservation, readiness/evidence lineage, Execution Graph proposal, reviewer identity, exact immutable plan binding, and isolated lifecycle progression. Test keys and dispatch are disposable/test-only and are not production trust evidence.

## Validation evidence

| Check | Result | Evidence |
|---|---|---|
| Full `npm test` | PASS, exit 0 | `artifacts/adaptive-goal-graph/final-verification-20261026T1630+0700-npm-test.log` |
| Trust configuration, verifier, reviewer, producer-to-three-graph disposable DB E2E | PASS, 28/28 | `artifacts/adaptive-goal-graph/final-verification-20261026T1630+0700-trust-e2e.log` |
| Reviewer anti-rollback and missing-ledger diagnostics regressions | PASS, 8/8 reviewer tests | Included in trust E2E log and extracted-package test output |
| Benchmark adversarial/provenance suite | PASS, 14/14 | `artifacts/adaptive-goal-graph/final-verification-20261026T1630+0700-benchmark-v20.log` |
| Package reproducibility | PASS; independent builds bit-for-bit identical | `artifacts/adaptive-goal-graph/final-verification-20261026T1630+0700-package-reproducibility.log` |
| Source-to-bundle alignment | PASS; 93 entries, 74 tools | `artifacts/adaptive-goal-graph/source-alignment-20261026T1630+0700-rc10.log` |
| MCP candidate fast test / extracted package regressions | PASS | `artifacts/adaptive-goal-graph/final-verification-20261026T1630+0700-mcpb-fast-test.log` and candidate build output |
| Documentation/link checks | PASS; 335 Markdown files and 279 local links checked | `artifacts/adaptive-goal-graph/final-verification-20261026T1630+0700-docs-check.log` |
| `git diff --check` | PASS after final documentation synchronization | `artifacts/adaptive-goal-graph/final-verification-20261026T1630+0700-git-diff-check.log` |
| ZIP integrity | PASS; no compressed-entry errors | `artifacts/adaptive-goal-graph/final-verification-20261026T1630+0700-archive-integrity.log` |

The benchmark v20 SHA-256 is `5f5e4f16da60ec94a7dfd9f83abcba484b4ad072b529b48aa0344e6706bcd882`. Historical fixture hashes v14–v19 remain unchanged; their hashes are preserved in the machine-readable dossier.

## Read-only live observations

- Latest read-only reconciliation: `artifacts/adaptive-goal-graph/live-reconciliation-20261026T1630+0700-rc10.json`, generated `2026-10-26T09:09:03.997Z`.
- Counts: 136 jobs, 5,304 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 118 approvals and **0 lease rows**.
- Of 84 considered active jobs: 60 are `EXECUTING` with 61 running tasks and no active leases; 6 await dispatch; 18 await proposal/approval. Owner/provider identity is not authoritatively persisted for the flagged cases, and execution/runtime observations do not establish that a worker is dead.
- No bulk reset, terminalization, retry, redispatch or live workflow DB mutation was performed.
- Fresh preflight: `artifacts/adaptive-goal-graph/rollout-preflight-current-rc10-20261026T1630+0700.json`, generated `2026-10-26T09:09:03.941Z`, exit 3, `BLOCKED`, `readOnly=true`, `liveMutationPerformed=false`.

## Remaining blockers and authority-owned remediation

1. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: the host administrator/security authority must provision the exact `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` values using independently administered providers, different Ed25519 public roots, exact scopes, auditable config versions and controlled key lifecycle. See [trust provisioning runbook](agg-production-trust-provisioning-runbook.md). No roots or signatures were generated for production.
2. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: a host-owned cryptographic verifier and independently protected monotonic checkpoint store must verify checkpoint signature, authority identity, chain continuity, anti-rollback sequence and exact candidate/rollback hashes. Self-asserted JSON flags and local SQLite history cannot satisfy this gate.
3. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` and `RUNNING_TASKS_MUST_DRAIN`: each flagged job/task must be correlated by its owner against current host/provider identity, runtime process identity, event, attempt, result, artifact, owner and lease evidence. Missing leases or age alone never authorize lifecycle changes. Reconcile each case under documented owner authority, then collect a fresh read-only report.
4. `CANDIDATE_VERSION_ALREADY_INSTALLED` from v18 was addressed at the candidate identity level by RC.9; RC.10 is a further distinct successor. The currently installed generation remains RC.8 and differs from this candidate; installation/activation is still not authorized until the other gates clear.

**Production readiness remains BLOCKED.** Offline tests establish software behavior only in disposable state; read-only live observations establish current stored/runtime signals only. Neither proves live production claim truth, independently administered trust, reviewer authorization, external anti-rollback, workflow drain, or a successful production Goal → Plan → Execution Graph run.

Machine-readable dossier: `artifacts/adaptive-goal-graph/acceptance-dossier-20261026T1630+0700-rc10.json`.

## Post-RC.10 reconciliation tooling follow-up — 2026-10-26

- A tooling-only gap was found: recovery-plan identity previously included only the latest 12 job events, even though older task-correlated events could still be relevant to a lifecycle decision.
- `scripts/reconcile-active-workflows.mjs` now records every task-correlated event ID/type and time range, with explicit `truncated: false`; deterministic recovery identity binds per-task event IDs and all job event IDs. Payload summaries remain bounded, result content is not copied, and the tool remains read-only. No lifecycle transition is inferred or authorized.
- Regression: `tests/test-reconcile-active-workflows.mjs` verifies an older completion event remains in task lineage and recovery identity despite newer events beyond the display window. Reconciliation tests pass 4/4.
- Benchmark successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v21.json`, SHA-256 `63f3fe9bd253841f0b6b6ce773d2829aebef0a46e77d3e8b033ecd9508b9b1de`. Benchmark suite passes 14/14. Historical v20 remains byte-identical at SHA-256 `5f5e4f16da60ec94a7dfd9f83abcba484b4ad072b529b48aa0344e6706bcd882`; v14–v19 remain untouched.
- Full `npm test` rerun: PASS, exit 0. `npm run docs:check`: PASS (335 Markdown files, 279 local links). `git diff --check`: PASS. RC.10 archive integrity remains PASS and archive SHA-256 unchanged.
- This follow-up changes diagnostics/benchmark tooling, not the packaged runtime; it does not justify a new runtime candidate by itself. RC.10 remains the latest candidate archive, not installed or activated. Original RC.10 dossier and checksum manifest are retained as historical evidence and are not rewritten to claim they cover these later tooling changes.
- Production decision remains **BLOCKED** by host-owned trust configuration, external monotonic checkpoint verification, and unresolved per-job/task owner/provider/runtime authority. Complete event IDs improve reconciliation; they do not prove worker death or authorize reset, terminalization, retry, or redispatch.

## RC.11 runtime trust-boundary successor — 2026-10-26

- Candidate: `artifacts/mcpb-candidate-build-20261026T1745+0700/runalith-1.0.9-rc.11-goal-idea-authenticated-projection-v22.mcpb`.
- SHA-256: `37c1d418f743190e1d1843995346c9e3296dafd29e47de1e42afb47b6f2870fd`; 807,458 bytes; 93 archive entries; 74 tools. Built and smoke-tested, not installed or activated.
- `src/runtime/adaptive-goal-knowledge-verifier.js` now marks only in-process reports returned by the verifier's fresh durable read as authenticated. Serialized/cloned report objects lose the marker and must be re-read and cryptographically verified.
- `src/runtime/adaptive-goal-plan-adapter.js` accepts trusted projection metadata only from that marked report and binds the exact persisted node/type/evidence-ref set and non-recovery edge set to the projected graph. Caller-controlled `verified: true` metadata fails closed.
- `src/runtime/adaptive-goal-execution-graph-proposal.js` rejects serialized drafts that merely recompute their unkeyed `draftHash` after asserting `verified: true`. Trusted source proposals must be rebuilt from the current durable Goal/Idea snapshot and attestation before the in-process authenticated projection can be consumed.
- `server/index-v1.0.9-rc.11.js` passes the verifier-owned report and re-verifies persisted knowledge snapshot metadata on proposal reconstruction. RC.10 entry point and archive remain untouched.
- Adversarial regressions cover forged verification flags and a rehashed forged serialized draft. Disposable-database three-graph E2E passes, including exact plan binding, reviewer identity, approval and isolated dispatch; this is not production E2E.
- Full `npm test` passes with exit 0. The v22 benchmark fixture is a successor for updated package/source provenance; historical fixtures v14–v21 remain unchanged.
- Candidate requires independent source-to-bundle alignment, archive integrity, extracted MCP fast test, reproducibility, documentation and diff validation before being treated as a release candidate. RC.8 remains installed baseline; RC.11 is not installed.
- Production remains **BLOCKED** by `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`, `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`, and `RUNNING_TASKS_MUST_DRAIN`. No live lifecycle or host mutation performed.
