# Goal/Idea → Plan → Execution Graph acceptance — RC.11 published candidate

Generated: 2026-10-26. UTC timestamps are used where explicitly stated.

**Decision: testing pre-release published; production activation remains BLOCKED.** The release validates the candidate in offline/disposable environments. It does not establish host production authority, prove that the target host loaded the candidate, or authorize changes to live workflows.

## Candidate identity and publication

- GitHub release: [Runalith 1.0.9-rc.11 (Testing Pre-release)](https://github.com/nplongx/runalith/releases/tag/v1.0.9-rc.11), published `2026-10-26T10:23:06Z`.
- Tag: `v1.0.9-rc.11`.
- Source commit: `ffee0815b8dfcac21d15d8eaeaf1d309aab2b7e2` (`feat: harden adaptive goal graph and workflow reliability`). The tag resolves to this commit.
- Asset: [`runalith-1.0.9-rc.11-goal-idea-authenticated-projection-v22.mcpb`](https://github.com/nplongx/runalith/releases/download/v1.0.9-rc.11/runalith-1.0.9-rc.11-goal-idea-authenticated-projection-v22.mcpb).
- Size: 807,458 bytes; archive entries: 93; manifest/runtime tools: 74.
- SHA-256: `37c1d418f743190e1d1843995346c9e3296dafd29e47de1e42afb47b6f2870fd`.
- Release flag: GitHub `isPrerelease = true`; the published asset metadata reports the same SHA-256.
- Local candidate build path at publication: `artifacts/mcpb-candidate-build-20261026T1745+0700/runalith-1.0.9-rc.11-goal-idea-authenticated-projection-v22.mcpb`. The `artifacts/` directory is local/ignored evidence, not part of the repository release tree.

This is a post-publication acceptance/index record. Later documentation-only commits do not change the source commit or bytes of the released package; rebuild and republish would be required for any runtime/package source change.

## Release-time validation

These checks were run against the exact RC.11 source/package candidate before publication:

| Check | Result | Scope and limitation |
|---|---|---|
| `npm test` | **PASS**, exit 0 | Repository test suite; offline/disposable tests do not establish production authority. |
| Package reproducibility | **PASS** | Two independent validated builds were byte-for-byte identical. |
| MCP candidate fast test | **PASS** | Packaged runtime startup and tool discovery/schema checks in the test harness. |
| Archive integrity | **PASS** | ZIP archive integrity verified; 93 entries. |
| Source-to-bundle alignment | **PASS** | Packaged entries aligned with the recorded RC.11 source snapshot. |
| Documentation/link check | **PASS** | Release-time run checked 87 Markdown files and 273 local links. |
| `git diff --cached --check` | **PASS** | No whitespace errors in the release changeset. |
| Historical fixture checksums | **PASS** | Recorded benchmark fixtures were preserved; v14–v22 identities remain history-specific. |

The repeatable-build input identity recorded for the RC.11 build was `8ceeb439030107c75e018d1b91e412952bb74e1bba31679a0b3dfe0591254d29`. Package tests use disposable trust material and isolated state; neither a test signature nor a content hash is a production trust attestation.

## Read-only host observations and operational boundary

The latest recorded read-only reconciliation is `artifacts/adaptive-goal-graph/live-reconciliation-20261026T1810+0700-rc11-followup.json` (SHA-256 `863c6a94996d157ce726da76fcdc47e715e8cc574c8c157a523909f3be3f5d79`). It observed 136 jobs, 5,304 events, 1,277 tasks, 908 results, 867 artifacts, 982 attempts, 118 approvals and zero lease rows. The active inventory contained 60 `EXECUTING` jobs and 61 running tasks.

All 61 running tasks lacked persisted execution metadata and had unresolved authoritative owner/provider/runtime identity. Zero lease rows do not prove that workers are dead. The report authorizes no lifecycle action; each record requires owner/provider reconciliation and a fresh report after any separately authorized action. See the [RC.11 recovery guidance](goal-plan-execution-recovery-guidance-rc11-followup.md).

- Installed host generation: RC.8 in the recorded installed-version verification; RC.11 was not installed or activated as part of this release.
- Rollout preflight: exit code `3`, decision `BLOCKED`, read-only; this is a blocker report, not approval.
- Installed verification: exit code `4` due to the expected RC.8-versus-RC.11 version mismatch. Do not clear this mismatch by installing the candidate while any other gate remains blocked.
- No production install/activation, registry/configuration edit, host restart, live workflow database mutation, dispatch, kill, reset, retry or terminalization was performed for this release.

## Remaining production blockers

1. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`.** The host/security authority must provision `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` through host-owned configuration loading. Independently verify their effective runtime values, independent provider administration, distinct provider IDs and disjoint Ed25519 public roots, exact scopes, versions, validity and key rotation/revocation state. See the [trust provisioning runbook](agg-production-trust-provisioning-runbook.md).
2. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`.** A host-owned authenticated checkpoint adapter and independently protected monotonic store must verify challenge signatures, authority identity, exact candidate/rollback hashes, freshness, sequence and continuity. The repository contract explicitly returns `productionAuthorityEstablished: false`; caller-supplied `verified` / `signatureVerified` fields and local SQLite history cannot close this gate.
3. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`.** Reconcile each of the 60 `EXECUTING` jobs using authoritative owner/provider/runtime identity, event and attempt history, result/artifact lineage and fencing evidence.
4. **`RUNNING_TASKS_MUST_DRAIN`.** Reconcile each of the 61 running tasks with its owner/provider/runtime before selecting an authorized lifecycle transition. A missing lease is not proof of process death and is not authority to kill, retry, reset, redispatch or terminalize.

The [RC.11 release notes](release-notes-1.0.9-rc.11.md), [trust runbook](agg-production-trust-provisioning-runbook.md), and [recovery guidance](goal-plan-execution-recovery-guidance-rc11-followup.md) define the evidence and owner actions needed. Production remains blocked until the gates are independently verified; do not reinterpret offline success, a published pre-release, or a successful read-only diagnostic as activation authorization.

## Evidence and versioning notes

Historical acceptance reports remain historical and are not rewritten to imply that earlier candidates were RC.11. The follow-up reconciliation report and local acceptance dossier are kept under the ignored local `artifacts/` tree; this document records durable release identity, validation scope and remaining blockers without making those local reports publicly retrievable. Changes to runtime/package inputs require a new candidate identity, reproducible build, source alignment and corresponding release checks.

The documentation-only follow-up that adds this acceptance index and refreshes the public entry points was separately checked: `npm run docs:check` passed with 88 Markdown files and 292 local links, `npm run test:batch` passed with exit 0, and `git diff --cached --check` passed. These follow-up checks do not rebuild, replace or alter the published RC.11 asset.
