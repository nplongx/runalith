# Runalith 1.0.9-rc.71 rollout dossier — v146 engineering evidence

## Decision

**BLOCKED — do not install, activate, publish, approve, dispatch, or mutate production state.** RC.71 v146 is a locally built engineering artifact. Local tests, hashes, reproducibility, archive/source alignment, and read-only diagnostics do not establish the Phase 2 contract, independent release authority, production trust, external checkpoint continuity, or authoritative workflow/task drain.

- Candidate: `dist/runalith-1.0.9-rc.71-versioned-approval-subsystem-20261030-v146.mcpb`
- Version: `1.0.9-rc.71`
- SHA-256: `6b248375286fbc0039b31aede3271ec8987f0160b65aba040e8aa768c1a986e9`
- Size: 981,834 bytes; 107 archive entries; 75 manifest tools; 75 runtime tools
- Entrypoint: `server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js`
- Local rollback reference: `dist/runalith-1.0.9-rc.26-executing-state-reconciliation-final2-20261028.mcpb`
- Rollback SHA-256: `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`
- Rollback status: local archive smoke and installed-file parity verified; not authorized production rollback authority

The earlier v145 archive is a new, non-overwriting artifact path but was byte-identical to v144. The v146 archive is the actual binary successor: it packages the new Approval Subsystem outage regression, increasing archive size by 138 bytes and changing the candidate digest. No production runtime behavior was changed by that test-only addition.

## Engineering changes

### Candidate/rollback smoke compatibility

The earlier v144 preflight exit 1 was not caused by missing fields in the RC.71 candidate. Direct parsing confirmed both source and v144 archive manifests contained all five AGG trust configuration inputs. Preflight also smoke-tests its RC.26 rollback bundle. The candidate validator incorrectly applied the RC.71 five-domain expectation to that historical two-domain bundle.

`scripts/test-mcpb-candidate.mjs` now applies versioned expectations:

- RC.71 and later: exactly five independently administered AGG trust configuration fields.
- RC.17 through RC.70: preserve the historical two-field schema for rollback compatibility.

No five-domain expectation was weakened for RC.71. Smoke tests passed for RC.71 v146, RC.70 and RC.26. The fresh v146 preflight therefore reaches the normal exit-3 `BLOCKED` decision rather than the earlier validator error.

### Extracted-package regression

`tests/test-extracted-package-tool-schemas.mjs` now verifies the actual extracted RC.71 manifest has exactly five administrator-managed trust inputs, each blank by default, optional, public-key-only, and mapped to its exact host environment variable. The test also enables the three manifest-advertised opt-in tools during extracted runtime schema inspection; this makes the check compare all 75 manifest/runtime tools rather than only the default 72.

### Benchmark provenance

Immutable successors:

- `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v145.json` — SHA-256 `9d7d73d8cf65043f51dac5541962f3088646af8a769efa623a63c569e676b61b`
- `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v146.json` — SHA-256 `5eec91752ccd72d1caa4d0f851ea2e71a2525c4b5d9a56062339e22663b54133`
- `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v147.json` — SHA-256 `7e19eac297032a31db0a3e09e3cd129cbcfdfe60e0c5279776cd484b09c91f7b`

v147 is the active runner/test fixture. It records exact source-byte transitions from v146, including the new trust/policy-ledger outage regression. `schemaVersion: 117`, `fixtureId: recovery-verifier-investigation-v117`, `supersedesFixtureId: recovery-verifier-investigation-v116`, frozen `groundTruth`, and task/node/edge identities are unchanged. v144, v145, v146 and all earlier fixtures remain byte-for-byte preserved.

## Validation evidence

All paths below are relative to `artifacts/adaptive-goal-graph/run-baseline-integrated-20261029T1535+0700/`.

| Check | Result | Evidence |
|---|---|---|
| RC.71 package build to unique v146 path | Exit 0; 981,834 bytes | `rc71-package-build-v146-20261030T021435Z.log` |
| Candidate smoke v146 | PASS; 107 entries; 75/75 tools | `rc71-focused-validation-v147-20261030T021611Z.log` |
| Historical rollback smoke RC.26 and RC.70 | PASS; 74/74 and 75/75 tools | `rc71-historical-rollback-smoke-final-20261030T022556Z.log` |
| Extracted package schema | PASS; 75/75 tools and five trust mappings | `rc71-focused-validation-v147-20261030T021611Z.log` |
| Approval Subsystem unit tests | PASS; 8/8, including unavailable trust-ledger and policy-ledger fail-closed cases | `rc71-approval-ledger-outage-20261030T021321Z.log` |
| Integrated plugin runtime and extracted package E2E | PASS | `rc71-package-build-v146-20261030T021435Z.log` |
| Package no-overwrite | PASS | `rc71-focused-validation-v147-20261030T021611Z.log`; v146 package build also completed with exclusive output path |
| Benchmark v147 | PASS; 15/15 | `rc71-benchmark-v147-20261030T021422Z.log` |
| `sourceNodeId` proposal/candidate contract | PASS; 21/21 | `rc71-proposal-sourceNodeId-20261030T021254Z.log` |
| Package reproducibility | PASS; two independently staged local builds match | `rc71-reproducibility-v147-20261030T021708Z.log` |
| Full source suite | PASS; `npm test`, exit 0 | `rc71-npm-test-v147-20261030T021953Z.log` |
| Documentation | PASS; 179 Markdown files, 367 local links, 75 tools | Final command log and SHA-256 pinned in acceptance evidence index |
| `git diff --check` | PASS; exit 0 | Final command log and SHA-256 pinned in acceptance evidence index |
| CodeGraph | Index current; 531 files, 28,405 nodes, 151,156 edges | Final sync/status log and SHA-256 pinned in acceptance evidence index |
| Exact source/archive alignment | `PASS_EXACT_ARCHIVE_ENTRY_BYTES`; 107 entries; 75 tools | Final current-tree report is pinned in the append-only acceptance evidence index and hash manifest |
| Read-only rollout preflight | Expected exit 3; `BLOCKED`; no mutations | `preflight-rc71-v146-20261030T022245Z.json`; report SHA-256 `16b6fa1ae27ca60c6f84764e83bbde1c344334404ec71e8558406bd70f729446` |
| Read-only workflow/task reconciliation v2 | PASS as diagnostic only; exit 0 | `workflow-reconciliation-readonly-v145-20261030T020947Z.json` |
| Read-only Goal/Idea graph reconciliation | PASS as diagnostic only; exit 0 | `graph-reconciliation-readonly-v145-20261030T021057Z.json` |
| Fresh Goal/Idea snapshot read | Unverified; evidence-ineligible; no attestation | `live-goal-snapshot-rc71-v145-20261030T021300Z.json` |

The source-alignment report describes local working-tree/archive byte identity only. Its source provenance remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`, and release eligibility remains blocked pending authenticated builder evidence and independent authority. Reproducibility proves two local builds agree; it does not authenticate the builder.

## Current Goal/Idea → Plan → Execution state

The fresh Goal/Idea snapshot is structurally hash-valid but has no evidence references, no evidence manifest entries, no configured verifier, no signature, and no planning authority. Exact snapshot hash: `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`.

The fresh read-only reconciliation reports:

- Two Goal/Idea graphs; both evidence-ineligible and without attestation/current authenticated snapshot binding.
- Four historical planner evidence source-hash mismatches. Preserve their historical records; cause is not established by the mismatch itself.
- Three persisted Plan Graph proposals; 22 observed steps, all 22 missing validated supporting evidence.
- All three Plan Graph proposals lack authenticated current-snapshot binding, are marked unverified-source, and lack independent source revalidation.
- Zero persisted Execution Graph proposals and zero execution-plan-candidate events in the observed workflow database.

These are live-state blockers, not proof that the isolated RC.71 three-graph E2E failed. The isolated E2E and test trust roots prove local implementation behavior only. No Goal/Idea graph write, evidence producer mutation, workflow proposal, approval, or dispatch was performed to make the live database appear complete.

The historical `sourceNodeId` provenance gap is covered by the current Execution Graph proposal contract and negative regression: source-node identity is bound to the immutable Plan Graph draft mapping; rewriting it and recomputing exposed node/step/binding/envelope hashes is rejected unless the original mapping remains intact. Full `npm test` includes this proposal regression.

## Approval security boundary

RC.71's versioned Approval Subsystem separates three new trust domains—signed reusable approval policy, authenticated maker attestation, and checker decisions—from the existing Goal/Idea verifier and reviewer identity domains. The full five-domain set must be pairwise disjoint. The signed policy defines quorum, roles, trust domains, veto, maker/checker separation, and freshness; runtime does not invent a default quorum.

The immutable `approval.approved` event stores the signed evidence and verified binding in the same workflow writer transaction as the immutable plan pin. Retries must reproduce the exact original signed evidence. The current runtime's `verifiedAdaptiveGoalApprovalBindingForTransition` re-reads the unique durable approval event, re-verifies signed policy/maker/checker evidence against current trust/revocation and policy high-water, and compares the reproduced binding, proposal hash, and immutable plan hash. CodeGraph traces its callers through `workflowPreflight`, `executeDurableBatch`, and `callToolImpl`.

Approval tests cover missing/unobserved roots, provider/root collisions, tampering, wrong candidate/plan/action/evidence binding, maker/checker reuse, insufficient quorum/trust domains/roles, expiry, revocation, nonce replay, policy version rollback/reuse/gaps, idempotent/concurrent transaction behavior and recovery. These use disposable test-only trust; no production trust was provisioned or observed. The local policy high-water event is not an external monotonic checkpoint.

## Six production blockers — all OPEN

| Blocker | Missing authority evidence and owner | Safe remediation | Recheck |
|---|---|---|---|
| `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` | Phase 2 contract owner, platform security, controlled builder: owner-signed canonical sorted 71-path manifest; candidate/source/tree-bound builder receipt; host-pinned policy `/etc/runalith/phase2-custody-trust.json`. | Obtain real signed manifest/receipt and approved host policy from their owners. Do not infer the path list from archive count, trim files, or create local signatures. | `verify-phase2-custody-evidence.mjs` must report `CRYPTOGRAPHIC_AND_SOURCE_BINDINGS_VERIFIED`; then rerun read-only preflight against exact candidate and rollback. |
| `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` | Independent builder, independent verifier, release authority, host operator: host release policy `/etc/runalith/release-policy.json`, signed builder provenance, independent verification, release approval, host-issued one-time nonce, exact candidate/baseline/rollback bindings. | Run controlled hosted build and independent verification; obtain authorized release decision and signed outputs for the exact candidate digest. | Release verifier accepts signatures/bindings; preflight reports `productionReleaseEligible=true`. Local hash/build/reproducibility is insufficient. |
| `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` | Host/security administrator plus independent Goal/Idea verifier and reviewer identity authorities; for RC.71 also independent policy, maker, and checker authorities. All five versioned public-key trust configurations and effective host runtime ledger observations are absent/unverified. Current preflight observes `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` blank. | Provision authority-issued public Ed25519 roots, provider IDs, exact scopes, validity/revocation and audit metadata through host-supported configuration. Keep private keys with external authorities. Explicit observation must occur only under separately authorized trust-ledger procedure. | Verify all five effective domains, distinct provider IDs and disjoint SPKI roots, current versions/fingerprints, revocation and anti-rollback; then rerun preflight. |
| `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` | Host/security authority and independently operated checkpoint-store authority: root-pinned host policy, protected adapter identity, separate trust roots, independent monotonic store, fresh signed continuity/CAS receipts. Preflight reports `NOT_CONFIGURED`. | Provision and independently audit adapter/store outside plugin tree; establish monotonicity across restart/restore boundaries. No diagnostic checkpoint transition. | Read-only preflight validates fresh candidate/rollback-bound continuity and independent monotonic state. `--advance-external-checkpoint` remains prohibited absent separate explicit authorization. |
| `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` | Each workflow owner plus provider/runtime operator. Local SQLite diagnostic: 86 jobs; 60 classified `EXECUTING`/stale-candidate reconciliation; 7 awaiting dispatch; 19 awaiting proposal/approval. Owner identity is unverified for all 86; provider identity is not persisted. | Reconcile each job against authenticated host/provider records, events, attempts, results, artifacts, active-task pointer and lease fencing. Keep each unresolved job on HOLD. | Fresh read-only reconciliation shows zero unresolved executing jobs and authoritative matching outcome/completion lineage per job. Never bulk-reset, retry, cancel, terminalize, kill, approve or dispatch from stale age. |
| `RUNNING_TASKS_MUST_DRAIN` | Each task owner plus provider/runtime and lease authority. Local diagnostic observes 736 tasks, 61 marked running, all 61 without active lease rows and without execution metadata; zero authoritative terminal dispositions assessed. | Obtain owner/provider process identity and matching attempt/result/artifact/completion evidence per task. Missing lease/PID is not proof of worker death; retain HOLD for uncertain remote effects. | Fresh reconciliation shows zero unresolved running tasks with consistent attempt/result/artifact/completion and lease history. |

The v2 reconciliation recovery plan assigns `HOLD_FOR_OWNER_RECONCILIATION` to all 86 jobs and authorizes no automatic lifecycle actions. It is a local SQLite diagnostic, not authenticated provider/worker disposition. The host preflight observes the active installed generation is still RC.26; do not kill or restart its process as a shortcut.

## Evidence classes and preserved discrepancies

- **Locally verified:** tests, candidate smoke, extracted schemas, reproducibility, benchmark, docs, CodeGraph, and exact archive/source byte comparisons listed above.
- **Local consistency only:** candidate SHA/size, archive entry parity, benchmark source pins, local high-water events, and SQLite reconciliation. None proves production authority.
- **Current authority evidence missing:** Phase 2 signed custody, independent builder/verifier/release approval, five production trust domains, external checkpoint continuity, and authenticated owner/provider workflow/task dispositions.
- **Historical evidence preserved:** v144 preflight exit 1, earlier failed smoke/schema logs, prior RC.67/RC.70 dossiers, source/README digest discrepancy, RC.23/RC.26/RC.67/RC.70/v144 archives, and all benchmark predecessors. The v144 exit-1 cause is now understood as applying RC.71's five-domain smoke expectation to the RC.26 rollback archive; the original log remains unchanged.

The historical README digest discrepancy remains unresolved. No historical hash, archive, dossier, fixture, acceptance index or log was overwritten. RC.26 local parity does not establish production rollback authorization.

## Actions not performed

No production activation/install, live approval/dispatch, workflow/task/lease mutation, Goal/Idea graph write, trust configuration write/observation, trust-ledger write, external checkpoint transition, host registry/process change, commit, reset, clean, rebase, push, or history rewrite. The fresh Goal/Idea snapshot and both reconciliation commands were read-only.

## Authority handoff

The six owners above must provide the named artifacts/decisions through their authenticated channels. Repository engineering cannot manufacture those inputs. After each owner handoff, verify the artifact independently, bind it to candidate SHA-256 `6b248375286fbc0039b31aede3271ec8987f0160b65aba040e8aa768c1a986e9` and rollback SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`, then rerun read-only preflight and workflow/task reconciliation. Keep `BLOCKED` until all six are closed with current independent authority evidence.

Engineering may continue on isolated tests and source hardening. It must not repair the live graph or drain workflows by unauthorized mutation. The highest-value next work is to preserve the verified RC.71 runtime boundary while closing additional negative tests for trust-service outage and concurrent dispatch under durable recovery, and to refresh source alignment/evidence indexes after any source change.
