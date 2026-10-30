# Runalith 1.0.9-rc.67 local rollout dossier — 2026-10-29

## Decision

**BLOCKED. Do not activate, publish, approve, or dispatch in production.** This is a local engineering successor only. Read-only preflight exited 3 with `BLOCKED`, `canActivateNow=false`, `readOnly=true`, and all mutation flags false. It verified the RC.67 archive and local RC.26 rollback reference, but did not establish independent release authority.

- Candidate: `dist/runalith-1.0.9-rc.67-dispatch-retry-request-binding-20261029.mcpb`
- Version: `1.0.9-rc.67`
- SHA-256: `2a62d9ed3ccd59230e7c357186cbdc57d7ef65c81c54a85951ff9487336aa772`
- Size: 952,303 bytes; 105 archive entries; 74 tools; 4,084,631 expanded bytes
- Selected entry point: `server/index-v1.0.9-rc.67.js`
- Exact source snapshot SHA-256: `8f639b6983ab9cd89b454952bbba753b3b47c1a5fea002dd826ff5100cb69447`
- Source provenance: `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`
- Release eligibility: `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`

Byte alignment means selected archive entries match selected local source bytes. It does not authenticate builder, verifier, approver, trust roots, or production state.

## RC.67 engineering delta

`src/runtime/job-store.js` now binds a retry of an already-`EXECUTING` job to the original durable dispatch request and event lineage. Retry succeeds only if active task ID, job, role, exact description, running status, exactly one started attempt, and exactly one matching canonical `task.dispatched` event all agree. Changed descriptions, missing/ambiguous attempts, duplicate or altered dispatch events, and inconsistent active-task pointers fail closed. No retry creates another task, attempt, or dispatch event.

Regression in `tests/test-phase5-recovery.js`: exact retry returns same task; changed request payload is rejected; event count remains one. Active provenance fixture advanced to `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v119.json`; it preserves the v117 graph/task/scoring oracle and records prior source pins. v108, v117 and v118 remain unchanged. RC.66 runtime and archive remain preserved.

## Validation actually executed

| Check | Result |
|---|---|
| `npm test` | PASS, exit 0; `npm-test-rc67-final-20261029T121136Z.log` |
| `node --test tests/test-adaptive-goal-benchmark.mjs` | PASS, 15/15; `benchmark-v119-rc67-final-20261029T121554Z.log` |
| `npm run test:phase2-security-regressions` | PASS, exit 0; `phase2-security-rc67-20261029T120608Z.log` |
| Package build and extracted validation suite | PASS, exit 0; `package-build-rc67-20261029T120430Z.log` |
| `node scripts/test-mcpb-candidate.mjs dist/runalith-1.0.9-rc.67-dispatch-retry-request-binding-20261029.mcpb` | PASS; 74 manifest/runtime tools; isolated local-only MCP startup |
| `node scripts/verify-mcpb-source-alignment.mjs --bundle … --output …` | PASS exact archive-entry byte alignment; `source-alignment-rc67-20261029T120557Z.json` |
| `npm run test:package-reproducibility` | PASS, exit 0; `package-reproducibility-rc67-20261029T120608Z.log` |
| `node tests/test-package-no-overwrite.js` | PASS, exit 0; `package-no-overwrite-rc67-20261029T120608Z.log` |
| `npm run docs:check` | PASS; post-dossier final check: 173 Markdown files, 363 local links; exact log and exit-code sidecar are in the RC.67 acceptance index |
| `git diff --check` | PASS, exit 0; `git-diff-check-rc67-20261029T120608Z.log` |
| CodeGraph sync/status | PASS; post-dossier sync/status are up to date; exact logs and exit-code sidecars are in the RC.67 acceptance index |
| Read-only preflight with RC.26 rollback reference | Expected exit 3; `preflight-rc67-final-20261029T121438Z.json` |
| Read-only local workflow reconciliation | PASS; `workflow-reconciliation-readonly-rc67-20261029T121529Z.json` |

An earlier `npm test` attempt failed because the isolated Phase 1 evidence-pack fixture tree omitted the newly bound active fixture; another attempt exposed the v118 source pin becoming stale when the active runner advanced. The harness was corrected to carry historical v118 and active v119, and active provenance now binds exact bytes. Failure logs and exit-code sidecars remain preserved; final full suite and benchmark pass. This repaired local test-harness defect is not authority evidence.

## Fresh local operational observation — diagnostic only

At `2026-10-29T12:15:29.628Z`, read-only SQLite reconciliation observed:

- 86 active jobs considered: 60 classified `stale_candidate_reconciliation_required`, 7 awaiting dispatch, 19 awaiting proposal/approval.
- 736 tasks observed; 61 running tasks have no active lease row and 61 lack execution metadata.
- 0 verified authoritative terminal dispositions; local SQLite diagnostic cannot ingest authenticated host/provider terminal evidence.
- 86 jobs lack verified owner identity and persisted provider identity; all 736 observed tasks lack verified owner/provider identity.
- `task_leases` table contains zero rows in this local database snapshot.

The report states stale candidates do not prove worker death, missing leases do not authorize terminalization, and automatic lifecycle actions are unauthorized. Do not retry, replay, kill, terminalize, or mutate workflow/task state from this snapshot. Workflow/task owners must reconcile provider identity, external effects, event → attempt → task → result/artifact lineage, and authoritative terminal disposition.

Host trust environment variables were unset in the preflight environment, and required host trust/checkpoint files/adapter were not verified. This local observation does not establish external checkpoint state or organizational authority.

## Six unresolved RC.67 blockers

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — **Phase 2 contract owner** must provide canonical 71-path manifest and verifiable owner signature. The archive's 105 entries do not prove the 71-path contract is satisfied. Do not infer, trim, or fabricate the manifest.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — **Controlled builder, independent verifier, authorized release approver** must supply verifiable evidence bound to exact RC.67 archive/source snapshot and approved rollback bytes: authenticated builder receipt, independent verification, and signed release approval. Local hashes and test logs do not qualify.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — **Authorized production trust administrator** must provision host-managed policies and distinct verifier/reviewer roots through the supported admin path, then independently verify version, fingerprints, revocation state and authority separation. Test-only keys are not production trust.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — **External checkpoint authority and host administrator** must provision the trusted adapter and externally anchored monotonic checkpoint/continuity receipts; independently verify exact checkpoint state. No local ledger write or checkpoint transition was attempted.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — **Workflow/provider owners** must reconcile active/executing jobs and provide authoritative terminal/drain evidence. Missing lease alone is not evidence of worker death.
6. `RUNNING_TASKS_MUST_DRAIN` — **Task/provider owners** must reconcile running tasks, provider-side execution state, leases, attempts and terminal dispositions. No task mutation, retry or terminalization is authorized by this report.

Preflight remains `BLOCKED`, `canActivateNow=false`, `productionAuthorityGranted=false`. RC.26 is a locally verified rollback reference with matching local installed-file parity, not production release authority. A separate preflight using RC.66 as rollback was preserved and correctly reported additional rollback mismatch blockers; it was not substituted for the final RC.26 comparison.

## Historical lineage and safety

- RC.23, RC.26, RC.63, RC.64, RC.65 and RC.66 archives remain unchanged.
- Fixture v108 required SHA-256 remains `c9dbc751818709abb07f7861febc07e0b1a4f38fbb4b4ddde043d7195a190cc2`; v117 and v118 remain historical immutable fixtures.
- Historical README pin `e956f53344de2963427ab07baa711f164d2c3bb28301ff606647702eb86e548e` versus current bytes is not silently repinned; historical `PROVENANCE_SOURCE_HASH_MISMATCH` evidence remains preserved.
- No production activation, publication, live approval/dispatch, workflow/task/lease mutation, trust-ledger write, external checkpoint transition, host registry/process mutation, or authority fabrication occurred.

## Next highest-value action

Obtain and independently verify owner-signed canonical Phase 2 71-path manifest and release evidence for exact RC.67 bytes; provision production trust and external checkpoint continuity through authorized owners; reconcile workflow/task state using authenticated provider/owner evidence. Then rerun read-only preflight. Do not activate while any blocker remains.
