# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.23

## Decision

**Local integration/acceptance: PASS. Production readiness: BLOCKED.** RC.23 carries the source mismatch digest correction found during RC.22 validation. It does not change runtime dispatch logic; the entrypoint remains byte-identical to RC.22. A new candidate version is required because the corrected reconciliation test/tool is included in the MCPB inventory and the prior versioned archive must not be replaced in place.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.23-actionable-source-mismatch-recovery-20261028.mcpb`
- Archive SHA-256: `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; 852,332 bytes; 93 archive entries; 74 tools.
- Source snapshot SHA-256: `1c672a712e0dff91302031cd9d5fbefb778ede99384fff93da1dcdf0dcb281ec`.
- Source-alignment report: `/tmp/runalith-source-alignment-rc23-actionable-source-mismatch-recovery-20261028.json`, SHA-256 `17be9cf8f152dbb763e4c380e0d862d393ce941d0afc0543ec7cf58d1fdb2467`; `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`, 92 exact source matches plus one generated metadata projection. Authenticated release eligibility remains blocked.
- Entrypoint SHA-256: `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`, byte-identical to RC.22.
- Benchmark successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v65.json`, SHA-256 `40acdf4ac7cb4ab9b403b53702ee0e79744ec5bdc4b9b095ced85445bae4a19c`; v64 SHA-256 `497e6a91e17fe3b052be6c109e64b16cc377d334a294f5b1bd18f41deb5f3641` and earlier fixtures remain immutable.

## Implementation and acceptance

The read-only reconciler's `--include-sensitive-source-identifiers` option remains opt-in. When enabled, it emits the exact historical `file:` URI, expected SHA-256 parsed from `details_json` or the URI fragment, observed SHA-256, and resolver classification. Default reports remain redacted. The new regression omits `expectedSha256` from `details_json` deliberately and proves the expected digest still comes from the immutable URI.

No diagnostic path writes the historical row, rewrites the hash, adds evidence, changes a graph/proposal, or grants lifecycle authority. A mismatch stays a historical mismatch; new evidence may only be produced through an approved producer after the claim owner verifies semantic relevance.

- Full `npm test`: exit 0; log `/tmp/runalith-npm-test-rc23-actionable-source-mismatch-recovery-20261028.log`, SHA-256 `51f285013f25dbc4bfe6c320bd003bfdfa5559d38a097cb0c1126a5fba9a86c2`.
- Targeted reconciliation + benchmark suite: 24/24 pass; extracted MCPB tests include trust, reviewer, reconciliation and three-graph E2E checks.
- `npm run docs:check`: PASS, 113 Markdown files / 336 local links. `npm run site:check`: PASS, version `1.0.9-rc.23`, 74 tools and RC.23 acceptance link. `git diff --check`: PASS.
- Package reproducibility, MCP fast test and ZIP integrity results are recorded after their current validation command completes. Source-byte alignment is not authenticated builder provenance.

## Live reconciliation

The fresh RC.23 sensitive read-only report is `/tmp/runalith-live-reconcile-rc23-sensitive-source-mismatch-20261028.json`, SHA-256 `fca4f8262a230ca923901000166c346e4eab9092f1ec349483ae0cda9ce777ec`, mode `0600`. It observed 63 planner runs / 373 evidence rows, four source-hash mismatch findings, two evidence-ineligible Goal/Idea graphs with zero evidence references, three Plan Graph proposals / 22 steps missing `supportingEvidenceRefs`, three proposals missing authenticated current-snapshot binding, zero Execution Graph proposals, 60 jobs needing owner/provider/runtime reconciliation and 61 running tasks without lease rows. It was collected read-only; no live records were changed.

The report contains nine mismatch evidence rows across five unique URIs. Expected digests are now populated from the immutable URI even when `details_json` omits them:

| Historical source URI | Expected SHA-256 | Current observed SHA-256 |
|---|---|---|
| `src/runtime/adaptive-goal-execution-readiness.js` (two historical pins) | `9a52c6ef2ca3a44bbf485a1a444f204e741731c02f5cd5a258b21110b1b94cd4` or `b8adb2a4ffd03cbe178ef9c0b1a942743f2aac3dbe53360c1b8812efecea5ed6` | `5afffb98215b5c1cf0fe3ff9914b32705f3e510e2d8e2348ae1ca98eefbad339` |
| `docs/adaptive-goal-graph.md` | `8e7d3a92f0f5060761fac44815f90a696b71367edef78b20a385f148dbeb0aef` | `53c3127bb3208d7d96c36c48561d44854da16be65c57944ee61de4a1e44bc4ba` |
| `docs/agg-phase1-benchmark-methodology.md` | `ba15be2650a8f4680bceb59eb050c909d2969f62861dd0c48185f92fa9f14caa` | `1570a2d579f2e51efe7009a6803cb59329ebc029c294210e1a9f36d7e396e6ac` |
| `tests/test-adaptive-goal-compatibility.js` | `554e3e7355d6c2100dae104cc1fb8e79a266a7793252146e206a7d7ebfefed98` | `1996037164da01e48379bcce5df78a0d0422b6bb0c75c815cb854f37f8611b0c` |
| `tests/test-adaptive-goal-execution-readiness.js` | `722ec1c9e2f004782b1cc6f0c04c889022a5009c758a0087b17d34511c5436e3` | `b1cea223899278d13b2c6064442c0445d90f76fdcd79d7cad69441d1b99ae44d` |

These are old source pins, not permission to rewrite history. Preserve their mismatches and re-produce new source evidence only if the owner validates the claim.

## Production blockers

All six gates remain open: `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`, `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`, `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`, and `RUNNING_TASKS_MUST_DRAIN`. Required authority inputs remain owner-signed canonical 71-path manifest and controlled-builder receipt; independent signed release evidence/approval; separately administered versioned verifier/reviewer JSON trust configs with distinct provider IDs and disjoint Ed25519 SPKI roots; host-owned external monotonic checkpoint continuity/CAS receipt; and owner/provider/runtime reconciliation for each active job/task. Do not trim the 93-entry archive or manufacture any authority artifact.

Preflight report: `/tmp/runalith-preflight-rc23-actionable-source-mismatch-recovery-20261028.json`, SHA-256 `49d2173ffcaca7bf90bb7beb3fa3a6a58f51f6e1a45bd218eeeaa9364ab0db4e`; exit `3`, `BLOCKED`, `canActivateNow=false`, read-only, no live mutation and checkpoint transition `NOT_REQUESTED`.

No live workflow DB write, graph mutation, host configuration/registry change, process restart/kill, activation, external checkpoint transition or production dispatch occurred. Keep rollout `BLOCKED` until all gates are closed with independently verifiable evidence.

## Local three-graph integration follow-up — 2026-10-30

This dated supplement records fresh local engineering evidence. It does not rewrite the RC.23 candidate identity, replace historical evidence, or qualify a release.

### Implementation and executable coverage

- Extended `tests/test-adaptive-goal-current-scope-producer-e2e.mjs` at the actual MCP/runtime boundary. An injected SQLite event-insert failure during Execution Graph proposal creation now proves the wrapper job and proposal event roll back atomically; removing the test trigger and retrying creates exactly one durable proposal.
- The same disposable vertical-flow test now starts fresh server processes against the same private SQLite database and re-reads the signed Goal/Idea snapshot verification, Plan Graph proposal, Execution Graph proposal and immutable execution-plan candidate. It asserts exact snapshot/draft/proposal/compiler hashes survive reload and that reviewer identity / execution readiness do not appear merely because graph/candidate bytes persisted.
- The existing end-to-end success path still traverses nine real producer tasks and typed artifacts, Goal/Idea snapshot and isolated test attestation, nine-step Plan Graph mapping with prerequisite DAG, approved review wrapper, Execution Graph proposal, reviewed action-intent candidate, isolated reviewer/approval gates, immutable plan pin and disposable dispatch. Negative controls retain stale-source, evidence, signature, reviewer-expiry, missing-authority and unverified legacy-source denials.
- The new assertions and v156 provenance update add no production runtime semantics and introduce no new normative contract. The accumulated dirty worktree does include separate production-source implementation changes (RC.71 server, approval subsystem, scheduler/provider and WorkflowStore); those changes were preserved and exercised by the full regression chain, but none was applied to the live host during this follow-up. Test trust keys and approvals exist only in disposable test databases.

### Fresh validation

| Command | Result |
|---|---|
| `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs` | exit 0; 1/1 integrated E2E |
| `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs tests/test-adaptive-goal-execution-graph-proposal.js tests/test-adaptive-goal-execution-plan-candidate.js tests/test-adaptive-goal-execution-readiness.js` | exit 0; 32/32 |
| `node --test tests/test-adaptive-goal-approval-subsystem.mjs tests/test-adaptive-goal-store-dispatch-guard.mjs tests/test-adaptive-goal-reviewer-identity.js tests/test-adaptive-goal-evidence-lineage.js` | exit 0; 30/30 |
| `node --test tests/test-adaptive-goal-knowledge-verifier.mjs tests/test-adaptive-goal-trust-configuration.mjs tests/test-adaptive-goal-trust-entrypoint.mjs tests/test-agg-rc23-to-rc71-migration.mjs` | exit 0; 31/31 |
| `node --test tests/test-adaptive-goal-graph.js tests/test-adaptive-goal-discriminator.mjs tests/test-adaptive-goal-phase2-mcp-tool.mjs tests/test-adaptive-goal-phase3-mcts.mjs` | exit 0; 59/59 |
| `node --test tests/test-adaptive-goal-benchmark.mjs` | exit 0; 15/15 |
| `npm test` | exit 0; complete configured regression chain, including graph E2E, trust, approval, benchmark, rollout, plugin, dashboard and AGG regression/telemetry/remediation/consistency suites. RC.23 migration is separately exercised by the explicit migration command above; it is not included in `npm test`. |
| `npm run docs:check` | exit 0; 201 Markdown files, 486 local links, 75 registered MCP tools |
| `npm run test:package-reproducibility` | exit 0 |
| `bash -n scripts/package-runalith-mcpb.sh` | exit 0 |
| `git diff --check` | exit 0 |
| `unzip -tq dist/runalith-1.0.9-rc.23-actionable-source-mismatch-recovery-20261028.mcpb` | exit 0 |
| `node scripts/verify-mcpb-source-alignment.mjs --bundle dist/runalith-1.0.9-rc.23-actionable-source-mismatch-recovery-20261028.mcpb --output /tmp/agg-rc23-source-alignment-followup-20261030.json` | exit 1; expected current-source mismatch at `manifest.json`, not a ZIP-integrity failure |

The first full-suite attempt correctly failed closed because immutable v155 still pinned the pre-change E2E bytes. v155 was preserved unchanged; successor v156 was created and the benchmark runner/test now use v156. The full `npm test` rerun then passed. This is a provenance-fixture successor, not a new MCPB candidate.

### Candidate and provenance identity

- Preserved RC.23 archive: `dist/runalith-1.0.9-rc.23-actionable-source-mismatch-recovery-20261028.mcpb`, SHA-256 `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; archive bytes unchanged.
- Preserved v155 fixture SHA-256: `8b42fdab7969680f9116dcc9c924004469f68c2c083bd51e57c6ae6842f95335`.
- New v156 fixture SHA-256: `74a9667c347feeb7729572669f2df71704698a9b3a34cf8a09489438b3c25a69`; provenance revision 136; 177 unique source pins, zero mismatches. E2E, benchmark runner and benchmark test pins were checked against current source bytes. v155 and earlier fixture bytes remain unchanged.
- A fresh source-to-archive check against the preserved RC.23 archive exited 1 as expected: first mismatch is `manifest.json` (current source `f0a6d46bd888db6c1122776fe4986415cc9e9b476660c917da599bf4740db61c`; archive `d75d03da545372c5c0aa3ee6a96579cbba0f8a2d04f243419461581436091c56`). Historical RC.23 source-alignment evidence remains historical; it is not current-worktree alignment evidence.
- No RC.23-aligned release successor was built at this stage. Later RC.71 engineering archives are separate candidate identities and do not close the frozen 71-path contract, owner-signed custody inputs or independent builder/verifier evidence gates.

### Remaining engineering and authority boundary

The executable vertical flow is now exercised across independent runtime reload and both proposal persistence rollback boundaries. This does not close the larger V2 projection-completeness work: SQL/event caller inventories remain bounded lexical/source audits, non-SQL writer/read-set completeness is not independently established, and the normative same-physical-database transition barrier, crash/durability matrix and host adapter remain unresolved. Next substantial local work: finish V2-01 query-by-query reader/writer and mutation classification, manually resolving the known computed and multi-statement SQL/event callsites, imported wrappers and non-SQL writers; then add a reviewed projection manifest and drift tests. No AST parser is declared or dependency-approved in the current package, and the decision register does not select one, so do not introduce a parser dependency until that decision is made. Do not guess open projection semantics.

All external gates remain open: owner-signed frozen 71-path custody contract; independent candidate-bound build/release evidence; host-managed production trust and external checkpoint authority; authoritative owner/provider/runtime drain evidence for active workflows and running tasks. No production trust/checkpoint/ledger or workflow/task/lease/approval/dispatch state was mutated. No host restart, checkpoint advance, package activation or release occurred. **RC.71 rollout remains BLOCKED.**

## V2-01 event-writer inventory follow-up — 2026-10-30

This follow-up closes a bounded source-inventory task only. It does not qualify RC.23/RC.71, alter runtime event authorization, or close V2-01.

- Successor inventory: `docs/agg-external-checkpoint-v2-projection-inventory-20261030-v0.12.md`, SHA-256 `a0f81840eed07abcd2d25516298819fa0e9492cc3e092bb0d3353200036f5c4c`.
- Checked-in caller register: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261030-v0.1.json`, SHA-256 `4abbec1fc36c329cdaf04ddf8bc22d29c69ca5cecb3083cface95b2fa3218e74`. It captures 116 scanner-visible `recordEvent()` callsites (99 literal, 17 computed/unresolved), 72 literal event types, two separately enumerated direct SQL `INSERT INTO events` writers, and three query/binding sites for approval-policy high-water and reviewer attestation/replay reads.
- The 17 computed producer expressions have explicit source/data-flow notes. `WorkflowStore.transitionWorkflowPhase()` remains an unbounded caller-supplied event parameter; optional-module deployed/shared-database reachability remains unknown. All 72 literal event types remain `pending-query-reader-writer-review`. The direct SQL cross-check covers two observed INSERTs, not every possible direct mutation, alias, wrapper, generated SQL or non-SQL event store.
- Added regression in `tests/test-agg-v2-event-callers.mjs`: exact configured entrypoint/source hashes/callsite tuples, computed producer coverage, literal event set and the two direct SQL event inserts. `node --test tests/test-agg-v2-event-callers.mjs`: exit 0, 8/8. `node scripts/audit-agg-v2-event-callers.mjs --self-test`: exit 0.
- Benchmark provenance successor `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v157.json`, SHA-256 `a1959e08b793f5fc566af16f1f636dc6410286a2dcede1650828402c57629db6`, pins 179 source files/artifacts with zero mismatches and preserves immutable v156 predecessor SHA-256 `74a9667c347feeb7729572669f2df71704698a9b3a34cf8a09489438b3c25a69`. Frozen graph/scoring oracle and task/node/edge identities unchanged. This is a benchmark provenance fixture, not an MCPB candidate or independent release evidence.
- `node --test tests/test-adaptive-goal-benchmark.mjs`: exit 0, 15/15 on v157. The first `npm test` attempt stopped in benchmark provenance checks because v156 correctly rejected the modified tooling guide's stale source hash; v156 was preserved and v157 created as a successor. Full regression rerun status is recorded only after completion.

Remaining V2-01 gaps include complete reader/query/column mapping, every direct SQL and non-SQL writer, imported wrappers/aliases/generated SQL, historical event rows and payload versions, mutation/replay/recovery classification, independent review, and deployed process/shared-database confirmation. No event registry was enforced at runtime. V2-08 remains blocked. RC.23 archive identity remains unchanged; no successor MCPB was built. All production authority gates remain open and rollout remains **BLOCKED**.

## V2-01 event query classification follow-up — 2026-10-31

This supplement advances the bounded source inventory and records current local validation. It does not accept V2-01, create a projection manifest, qualify RC.23/RC.71, or grant production authority.

- Query register: `docs/agg-external-checkpoint-v2-event-query-register-20261030-v0.4.json`, SHA-256 `a878fdd149503d0fa5054f33a4af7782cba1a432dd47f0cfb2751c2713993960`. Input inventory `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261030T132800Z-multi-statement-aware-v2.json`, SHA-256 `45da27f66702536f2ae903813060a56e75eb548e3d48cc482472eefac357b7e1`.
- 193 unique runtime event SQL callsites across seven files: 189 readers, three event-row writers and one multi-statement `events` schema/trigger bootstrap with zero event-row data writes. The configured RC.71 entrypoint is selectively re-extracted for source drift; six unchanged runtime files reuse preserved inventory rows. Disposable-root regression appends one event query to a copied entrypoint, expects 194 rows/one drift file, and deep-compares complete unchanged rows.
- SQL-shape classification records 51 literal event-type predicates, 19 parameterized event-type predicates, lexical `WHERE` predicate columns, ordering, query purpose, source hashes and caller context. Producer comparison remains intentionally non-authoritative: 72 literal producer types, 39 without a matching literal type predicate, and 17 computed/unresolved producer expressions. These are review queues, not allowlist decisions.
- Writer/read-path trace: generic `recordEvent()` uses `INSERT OR IGNORE` with caller-dependent transaction/autocommit; approval policy high-water has three SQL callsites guarded by `workflowDb.isTransaction === true`; reviewer attestation uses direct insert inside `BEGIN IMMEDIATE`, verifier/readback and rollback on failure. Readers include approval nonce replay/policy high-water, reviewer attestation/nonce replay, execution-start/spawn authorization readback, task-dispatch evidence and task/lease/batch/session-delivery/recovery/liveness paths.
- Direct-caller transaction markers: 116 explicit marker pairs, 73 with no complete pair observed in that caller, three runtime-guarded approval-policy high-water callsites, one module-level schema bootstrap with no enclosing function. Caller/transaction inference is source-layout/brace-balance heuristic, not AST/control-flow proof.
- Cross-table anti-replay and execution-authorization inputs are linked to inventory v0.12 §§3–7 in `docs/agg-external-checkpoint-v2-event-query-classification-20261031-v0.3.md`. It preserves the evidence-backed `approvals.raw_text` disposition: exclude from semantic authorization projection on current evidence, while documenting `SELECT *` materialization and `approval.approved` payload `rawText`; not a claim that the field is never read.
- Benchmark provenance successor v158 preserves v157 SHA-256 `a1959e08b793f5fc566af16f1f636dc6410286a2dcede1650828402c57629db6`; graph/scoring oracle and task/node/edge identities remain unchanged. V158 is a local source-pin fixture, not an MCPB candidate or independent release evidence.

Validation after the query-register and documentation changes:

- Producer + SQL audit focused tests: 20/20; SQL mutation/query audit: 12/12; adaptive-goal benchmark: 15/15.
- Full `npm test`: exit 0.
- `npm run docs:check`: 205 Markdown files, 497 local links; 75 MCP tools match reference.
- `npm run test:package-reproducibility`: exit 0; `git diff --check`: exit 0.
- RC.23 archive SHA-256 remains `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; ZIP integrity check passes. No successor MCPB was built.
- Read-only code review found no remaining concrete findings after full-row drift comparison; reviewer confirmed register regeneration and source-pin equality.

Remaining V2-01 gaps: all 193 register `authorizationPurpose` values remain pending semantic reader review; every event query is not yet mapped to its exact payload consumer/state-machine invariant; 39 producer literals and 17 computed producers need call-chain resolution; aliases/wrappers/generated SQL/non-SQL stores, historical payload rows and external worker/shared-DB reachability remain incomplete. Deployed reachability is not established. #32 remains OPEN / Needs Evidence / Priority Untriaged; #39 remains blocked by #32/#36/#38; #44 remains blocked by #43/#36. No projection runtime was implemented, no issue was closed/Accepted, and no production trust/checkpoint/ledger/workflow/task/lease/approval/dispatch state was mutated. No host restart, checkpoint advance, package activation or release occurred. **RC.23/RC.71 production rollout remains BLOCKED.**

## Fresh live-state reconciliation — 2026-10-31

This addendum refreshes live diagnostics against the current workflow database while preserving RC.23 as the historical candidate baseline. The database observations are diagnostic only; they do not authenticate worker/provider state or authorize lifecycle transitions.

- Preserved candidate remains `1.0.9-rc.23`, 852,332 bytes, 93 archive entries, SHA-256 `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`. Its embedded RC.23 entrypoint still matches `server/index-v1.0.9-rc.23.js` byte-for-byte (SHA-256 `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`). Current source package is `1.0.9-rc.71`; current source-to-RC.23 alignment remains **FAIL/BLOCKED** at source `plugin/manifest.json` versus archive `manifest.json` (source SHA-256 `f0a6d46bd888db6c1122776fe4986415cc9e9b476660c917da599bf4740db61c`, archive SHA-256 `d75d03da545372c5c0aa3ee6a96579cbba0f8a2d04f243419461581436091c56`). The archive was not rewritten; no new RC.23-aligned successor MCPB was built in this round. A separate RC.71 engineering archive exists and remains a distinct, currently source-misaligned candidate.
- Fresh RC.23 archive checks: `unzip -tq` PASS; `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.23-actionable-source-mismatch-recovery-20261028.mcpb` PASS (`MCPB_FAST_TEST=PASS`, 74/74 manifest/runtime tools, `ok/local-only-mcp`, isolated temporary database). This validates the preserved archive in isolation, not current source alignment or production authority.
- Read-only graph reconciliation: `artifacts/adaptive-goal-graph/rc23-baseline-live-graph-reconciliation-20261031T044816Z.json`, SHA-256 `8b28fda48f876977e0109fc21c50b7b580a51b6fe43c0905e5510e84b0eb3e69`, generated `2026-10-31T04:48:16.855Z`.
- Read-only lifecycle reconciliation: `artifacts/adaptive-goal-graph/rc23-baseline-live-lifecycle-reconciliation-20261031T044752Z.json`, SHA-256 `8d7776c175f9976cf86187309016a573b3542909256886a7520ce927efe745e3`, generated `2026-10-31T04:47:52.474Z`. Both reports read the same canonical workflow DB and have mode `0600`; capture times differ by 24.381 seconds, so they are not one atomic cross-report snapshot and cannot exclude concurrent writes between observations.
- Fresh read-only rollout preflight: `artifacts/adaptive-goal-graph/rc23-baseline-rollout-preflight-20261031T0500Z.json`, SHA-256 `a550c6410785127c4ac8b50b56e690e329be05f4bbd437acf73888081921556e`. Result `BLOCKED`, exit 3, `canActivateNow=false`; all mutation flags false. It stopped after the exact candidate/source manifest mismatch, so host inspection and the six authority gates were explicitly `NOT_EVALUATED_AFTER_CANDIDATE_SOURCE_ALIGNMENT_FAILURE`; this is not a fresh evaluation or closure of those gates.
- Workflow inventory: 87 active jobs considered (7 awaiting dispatch, 19 awaiting proposal/approval, 61 flagged for owner reconciliation); 746 tasks observed, 62 `running`, all 62 without active lease rows or execution metadata. The database contains 139 jobs, 5,352 events, 1,287 tasks, 992 attempts, 917 results, 876 artifacts, zero lease rows and 120 approvals. Owner identity and provider identity are unverified/not persisted for all 87 considered jobs; verified authoritative terminal dispositions remain zero. Missing leases are not proof of worker death. Automatic lifecycle actions remain disabled.
- Goal/Idea inventory: `runalith-agg-e2e-20261026` has 8 nodes, 9 edges, 8 memberships and zero evidence references; it remains ineligible for attestation. `runalith-agg-e2e-20261026-clean` has 16 nodes, 7 edges, 16 memberships and 9 durable artifact references with producer/result/attempt/completion lineage verified; its evidence is eligible to request independent attestation, but no attestation, claim-truth decision, independence decision or planning authority is present.
- Persisted proposals: 4 Plan Graph proposals and 31 steps; 22 steps have no supporting evidence. All 4 proposals lack authenticated current-snapshot binding and independent signature verification. One proposal declares references for all 9 steps, but zero references are verified; declarations do not replace authenticated source binding or evidence verification. There are zero persisted Execution Graph proposals and zero Execution Plan Candidate events.
- Planner source integrity: 4 finding groups contain 9 historical `file:` evidence rows (6 distinct URI strings) across 5 source paths. Expected digests differ from current source bytes. No matching blob was found in reachable Git history; the cause of the historical capture/mutation mismatch is not established. Preserve the historical rows and hashes; recapture only through a new producer run after owner/source reconciliation.
- At the time of this live-state capture, the local D-01 cross-database TOCTOU remained open: RC.71 opened workflow state and trust history in separate SQLite files/connections (`server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js:64-85,149-154`). Approval/dispatch serialize on the workflow DB (`src/runtime/job-store.js:6911,7012`), while trust reads use the separate trust handle (`server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js:5964-5975,5997-6008`). A concurrent trust administrator/revocation writer could change trust state after the guard reads it but before workflow dispatch commits; `BEGIN IMMEDIATE` on the workflow DB does not serialize a writer to a separate trust DB. This is an unresolved cross-process race, not a demonstrated single-process bypass. The accepted D-01 direction requires two connections to the same canonical workflow DB plus a durable barrier/serialization protocol and verified migration/restore semantics. At that earlier capture, no separate implementation authorization had yet been supplied.
- The current isolated E2E proves producer artifacts, Plan DAG, persisted/read-back proposals, reviewer/approval checks and dispatch within a disposable database using isolated trust fixtures. It does not establish production trust, live Goal/Idea attestation, host/provider identity or production dispatch authority.
- Full configured `npm test` ran 29 Node test groups / 415 tests with no failure markers and reached its final acceptance-consistency suite (5/5); complete log: `/tmp/runalith-agg-three-graph-full-test-20261031.log`. Overall process exit was **NOT CAPTURED**: the post-run shell wrapper failed to print it because `status` is a read-only zsh variable. Focused graph/trust/migration suite: 83/83. `npm run docs:check`: 209 Markdown files, 500 local links, 75 MCP tools. `git diff --check`: exit 0.
- All six RC.23 gates remain **OPEN**: `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`, `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`, `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`, `RUNNING_TASKS_MUST_DRAIN`. The first four still require independent owner/host/security/external-authority evidence; the refreshed workflow/task reports support investigation of the final two but do not authorize drain or establish terminal dispositions. No production trust/checkpoint/ledger or workflow/task/lease/approval/dispatch state was mutated.

## Integrated implementation follow-up — 2026-10-31

The Project Owner's latest instruction explicitly authorizes source-backed local runtime/test/migration work while preserving production and live-state prohibitions. This permits bounded implementation; it does not waive the normative V2 prerequisites in decision register §§11.3–11.5 or normative spec §§17–18.

- **Execution Graph approval invariant:** `server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js` now requires exactly one persisted Execution Plan Candidate before approval, and requires fresh candidate reconstruction, trusted reviewer identity and `executionReviewReady=true`. Missing candidate fails with `AGG_EXECUTION_CANDIDATE_REQUIRED`; it cannot pin an immutable plan or advance approval.
- **Lifecycle readback invariant:** both `readAdaptiveGoalExecutionGraphProposal` and `readAdaptiveGoalExecutionPlanCandidate` now require `job.status === 'active'` in `IDLE` and `APPROVED` states. Terminal/inactive wrappers report stale instead of fresh. `EXECUTING` already required active status.
- **Reviewer trust observation ordering (D-01 local slice):** `assertAdaptiveGoalReviewerAttestation` now performs read-only inspection of the exact observed trust configuration version/fingerprint/provider. Missing observation fails with `AGG_TRUST_CONFIG_NOT_OBSERVED`; signature verification no longer implicitly writes trust history while a workflow transaction is held. The explicit host/admin reviewer trust-status operation remains the writer/high-water observation boundary. Reviewer ingestion keeps its workflow `BEGIN IMMEDIATE` transaction but only reads trust history during verification.
- **Same-file/two-connection proof:** `tests/test-adaptive-goal-reviewer-identity.js` opens two independent SQLite handles to one disposable file, records trust observation before the workflow transaction, then ingests/revalidates a reviewer assertion while the workflow handle owns `BEGIN IMMEDIATE`. This proves the local read-only ordering on a shared physical file; it does not establish production logical DB identity, external generation/restore epoch or host authority.
- **Negative E2E:** `tests/test-adaptive-goal-current-scope-producer-e2e.mjs` removes the persisted candidate event in disposable DB while retaining valid signed approval evidence; approval is denied and job remains `IDLE` with no plan/tasks. It also temporarily marks `IDLE` and `APPROVED` wrappers `completed`; proposal/candidate readback returns `stale`, then exact test state is restored.
- **Focused validation:** `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs tests/test-adaptive-goal-reviewer-identity.js tests/test-agg-rc23-to-rc71-migration.mjs tests/test-adaptive-goal-store-dispatch-guard.mjs` exit 0, 21/21. Reviewer-specific suite exit 0, 15/15. The E2E confirms the full producer → Plan DAG → Execution proposal → reviewer → approval → immutable pin → dispatch chain only in isolated SQLite.
- **D-01 remaining:** production currently still opens trust and workflow as separate files. The read-only reviewer verification removes one nested-writer hazard and proves the code can use two handles on one file, but it does not eliminate cross-file TOCTOU. No trust-ledger migration was run. Normative V2 projection inventory, `logical_db_id`/generation/restore-epoch issuer, barrier/fencing primitive, effective WAL/durability policy, crash/restore semantics and external ledger anchor remain unresolved. A destructive or authority-improvised migration remains prohibited.
- **Candidate integrity:** RC.23 archive remains byte-identical (SHA-256 `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`). Separate RC.71 engineering archive `dist/runalith-1.0.9-rc.71-engineering-successor-20261030.mcpb` remains byte-identical (SHA-256 `fe1fc383cb2e64fcf0fc817fb0ed668137c922bd1e3b8052bf64fcf4fd0f8da2`), ZIP integrity PASS and isolated MCPB fast test PASS (75/75 tools). Current source alignment check against that RC.71 archive fails at `scripts/build-agg-live-remediation-plan.mjs` (source SHA-256 `67d77e37f7687980020abb27f7cb028e3a20ff08be96e8f92e027cc85046576f`, archive SHA-256 `fcb3d9e8f2bbee147aa0f5a8e79ec626a78a6ce960cc2b684ac27e348eae160a`). No package was rebuilt or activated.
- **Validation scope:** full `npm test` has not yet been rerun after these changes; capture process exit directly in the next validation pass. No production trust, checkpoint, workflow, task, lease, approval, dispatch or host process was modified.

## V2-01 source inventory drift successor — 2026-10-31

The full-test inventory failures were traced to legitimate byte/line drift in the configured RC.71 entrypoint and reviewer identity source, not to an added/removed event or SQL callsite. Historical v0.1 RecordEvent and v0.4 event-query registers remain untouched. Reviewed successors were generated and the focused regression now targets them:

- RecordEvent inventory `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T051500Z-v2.json`, SHA-256 `1e16f54662fb229f5b3ef63de033b19dea6184301655e60fe0f5411e190b43fc`; successor register `docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.2.json`, SHA-256 `3b3cb53fa1c3f6b27ee2ce06de96c9e5634d0d538076290b64b2bf17e143fac0`. 116 callsites remain; semantic producer tuples are unchanged. Three server callsite lines shifted by two.
- Direct SQL inventory `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261031T051500Z-v3.json`, SHA-256 `7cc2bd959ea064bf09eae972daa56e6ff7035cf7f1d37a197ff739f906af5986`; 1,460 callsites and operation-class counts unchanged, including 242 data writes.
- Event query register `docs/agg-external-checkpoint-v2-event-query-register-20261030-v0.5.1.json`, SHA-256 `3761f326c26b97c116df7845321cd19b64761eb16bb9819a1fb66ea9365dd5b5`; `sourceInventory` points to v3 and its digest matches. 193 event SQL callsites remain (189 readers, three writers, one schema-only bootstrap). Reviewer identity SQL source lines shifted by 14; query shape/count unchanged.
- Builder now accepts explicit `--inventory` and `--register-id`, and writes the actual source inventory path into its output. This prevents a successor from carrying a new inventory digest with a stale historical path.
- `node --test tests/test-agg-v2-event-callers.mjs tests/test-agg-v2-sql-mutation-audit.mjs`: exit 0, 20/20. The disposable-root drift test proves only the configured entrypoint is re-extracted and unchanged runtime query rows are reused exactly.

The Plan Graph lifecycle patch then changed the configured server source again. The v0.2/v3/v0.5.1 successors remain historical and untouched; latest successors:

- RecordEvent inventory v3 `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T054500Z-v3.json`, SHA-256 `436e1444ccbe079c7d8d9027126fbb524aa03f5fc07c6ce24604d6ce62e30c5e`; register v0.3 `docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.3.json`, SHA-256 `94f90d77d4e1b1c506cb43727ac730ba6d56a6e110666b315611cb9befa7f601`. 116 callsites and semantic tuples unchanged.
- Direct SQL inventory v4 `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261031T054500Z-v4.json`, SHA-256 `b944d4e74568a1f3c0de89bb128a3652fb062f5a654bb079de01bea26040b3d5`; 1,460 callsites, 242 data writes, operation-class counts unchanged.
- Event query register v0.5.2 `docs/agg-external-checkpoint-v2-event-query-register-20261030-v0.5.2.json`, SHA-256 `48dd6ec6fa04c4f4b6b86e78a4f5b755a56b057b82ad618b483830262d660156`; input path/digest match v4; 193 event SQL callsites unchanged.
- Latest focused inventory tests: exit 0, 20/20. Full `npm test` at `/tmp/runalith-agg-graph-full-test-20261031T053927Z.log` exited 1 at the v0.2 source-drift guard because Plan Graph lifecycle implementation changed the server hash. Tests now select v0.3/v4/v0.5.2; fresh full run pending.

All 193 `authorizationPurpose` fields remain pending semantic review; no 71-path projection, production writer inventory, deployed reachability or external authority is established. RC.23 and RC.71 archives and immutable release pins remain untouched.

## Benchmark provenance successor v160 — 2026-10-31

The next full-suite benchmark caught a stale exact source pin for the V2 inventory tooling document after the candidate verifier follow-up. Historical v159 remains byte-for-byte unchanged (SHA-256 `c9cda13ac00112153d8601498fe59cf18465834d6af6656fd970ed573b46ee24`); v158 also remains unchanged (SHA-256 `ab7c5b3e51f57875bbfb5f41ab0193c8788d0436646352d4ebeaa7ad0dab2cf9`). Versioned successor `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v160.json` (provenance revision 142) pins 200 source artifacts, including the current candidate verifier, v0.4 RecordEvent register/inventory, benchmark runner/test and updated dossier. All 200 pins independently re-hash with zero mismatches. Its predecessor SHA-256 is recorded in `migration.priorFixtureSha256`. Frozen `groundTruth`, task/node/edge identities, evidence requirements and scoring rubric remain byte-equivalent to v159. The benchmark runner defaults to v160; v159 and earlier fixtures remain in the historical chain. The fixture hash is reported in the verification log, not embedded in this pinned dossier source, avoiding a self-referential digest.

Validation: `node --test tests/test-adaptive-goal-benchmark.mjs` — exit 0, 15/15; `node --test tests/test-adaptive-goal-approval-subsystem.mjs` — exit 0, 10/10. The approval suite now rotates and explicitly observes each approval-policy, maker and checker trust configuration after a persisted approval, revokes the original root, and verifies dispatch-time approval evidence is rejected for all three domains. This is isolated local evidence, not proof of production trust configuration or external authority. The full `npm test` run at `/tmp/runalith-agg-graph-full-test-20261031T052433Z.log` exited 1 because benchmark tests still selected v158; rerun full suite after this successor selection and source-pin refresh.

## Plan Graph source lifecycle and trust-observation ordering — 2026-10-31

Independent graph review found `readAdaptiveGoalPlanProposal()` did not require the source Plan Graph wrapper's `jobs.status` to remain `active`, even though Execution Graph proposal creation calls that reader with `requireApproved: true`. The RC.71 server now rejects inactive Plan Graph sources with `SOURCE_PLAN_LIFECYCLE_INACTIVE` before either IDLE or APPROVED readback and includes active status in the defensive `requireApproved` guard. The isolated producer E2E marks both IDLE and APPROVED Plan Graph wrappers completed, verifies stale readback and blocked downstream Execution Graph creation with no additional job, then restores the disposable rows to active before continuing.

The full-suite follow-up also exposed an old plugin E2E fixture that attempted reviewer verification before the explicit host trust-status observation. The fixture now invokes `adaptive_goal_trust_configuration_status` before candidate verification; read-only verification remains non-writing. It no longer relies on an implicit trust-ledger observation. Focused validation: `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs` exit 0, 1/1; `node tests/test-runalith-plugin.js` exit 0. The immediately preceding full `npm test` run reached `tests/test-runalith-plugin.js` and failed at its obsolete reviewer-identity blocker assertion; this fixture ordering is corrected, and a fresh full run remains required. No production trust, workflow or task state was changed.

## Live workflow reconciliation — 2026-10-31T05:39:54Z

Read-only command: `node scripts/reconcile-active-workflows.mjs --db "$HOME/.chat-on-steroids/agent-orchestrator/workflow.db" --out /tmp/runalith-active-workflow-reconciliation-20261031T054000Z.json`. Exit 0; report SHA-256 `39b2e0ce292638d159017f1cc195bb24937d4b3c3b32fecacc8b181ffb3fa3c4`. Report declares `readOnly: true`, scope `active_and_executing_jobs`, considered/matching jobs 87/87, selection not truncated. It observed 62 running tasks and zero active leases; 61 jobs were flagged for reconciliation, with 61 jobs containing running tasks but no active leases. Classifications: seven awaiting dispatch, 61 stale-candidate reconciliation required, 19 awaiting proposal/approval. Table totals: 139 jobs, 1,287 tasks, 5,352 events, 917 results, 876 artifacts, 992 attempts, zero lease rows, 120 approvals.

This is a new 2026-10-31 snapshot; do not combine with historical 60-job/61-running-task counts. Missing leases do not prove worker death. No reset, terminalization, retry, drain, approval, dispatch, lease write or process action was performed. Owner/provider/runtime authority must reconcile each running task before lifecycle action. The Goal/Idea integrity overlay reports 24 nodes, 25 revisions, 24 memberships, 16 edges, two goals, zero attestations and four planner-evidence findings (`PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID`, detail `source_hash_mismatch`). `planningAuthorityEstablished` remains false. Current persisted graph state therefore does not support an authenticated snapshot/claim; local isolated E2E is not live-state evidence. The exact authority/artifact/decision/action/verification handoff is recorded in `docs/agg-production-trust-provisioning-runbook.md` §20.

## Final local validation and candidate disposition — 2026-10-31

- Full `npm test`: exit 0. Log `/tmp/runalith-agg-graph-full-test-20261031T054636Z.log`. This includes V2 inventory v3/v4 regressions, Goal/Idea/Plan/Execution suites, approval/trust tests, benchmark, rollout, plugin E2E and acceptance consistency.
- `npm run docs:check`: exit 0; 209 Markdown files, 504 local links, 75 MCP tool references aligned.
- `git diff --check`: exit 0.
- Persisted local preflight `artifacts/adaptive-goal-graph/agg-v2-local-source-preflight-20261031T055540Z.json`: result `PASS_LOCAL_CHECKS_WITH_EXTERNAL_GATES_OPEN`, SHA-256 `45fe766f798610ed02599589f43b3204494a4cfbcf04064515bb629b4f256c88`. It confirms 88 source files/116 RecordEvent callsites; 159 files/1,460 SQL callsites/242 data writes/62 computed-or-unresolved; disposable workflow/trust DB second-startup schema stability; historical RC.23 migration test 1/1; V2 SQL audit tests 12/12; authority-register tests 3/3; docs, whitespace and diff checks PASS. Authority register is structurally valid but has 19 dependencies, 20 open issues, 19 unassigned owners and `productionAuthorityGranted=false`; result remains `BLOCKED_EXTERNAL_AUTHORITY_DEPENDENCIES`. The report explicitly limits itself to local/source checks and does not access configured user DB, production host or live workflows.
- Benchmark v160: 200 source pins, zero mismatch; `node --test tests/test-adaptive-goal-benchmark.mjs` exit 0, 15/15. Historical v159 SHA-256 `c9cda13ac00112153d8601498fe59cf18465834d6af6656fd970ed573b46ee24` and v158 SHA-256 `ab7c5b3e51f57875bbfb5f41ab0193c8788d0436646352d4ebeaa7ad0dab2cf9` unchanged. The current v160 fixture hash is recomputed in final verification; it is not embedded in this pinned dossier, avoiding a self-referential digest.
- RC.23 archive: ZIP integrity PASS; archive SHA-256 `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; embedded `server/index-v1.0.9-rc.23.js` SHA-256 `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`, byte-identical to historical source. Archived manifest remains different from current `plugin/manifest.json` (archive `d75d03da545372c5c0aa3ee6a96579cbba0f8a2d04f243419461581436091c56`; current source `f0a6d46bd888db6c1122776fe4986415cc9e9b476660c917da599bf4740db61c`).
- RC.71 engineering archive: ZIP integrity PASS; archive SHA-256 `fe1fc383cb2e64fcf0fc817fb0ed668137c922bd1e3b8052bf64fcf4fd0f8da2`. Embedded versioned entrypoint SHA-256 `44c489cbf7e7ee2d1defd51065401de774d736bdc65bf98a05e86d49b243aed7` differs from current RC.71 source `12a8b3349bea1d6ae2347acb9b324d59c3686306961ce14a92c5f732038af57a`. `node scripts/verify-mcpb-source-alignment.mjs --bundle dist/runalith-1.0.9-rc.71-engineering-successor-20261030.mcpb` exits 1 at `scripts/build-agg-live-remediation-plan.mjs` (source `67d77e37f7687980020abb27f7cb028e3a20ff08be96e8f92e027cc85046576f`; archive `fcb3d9e8f2bbee147aa0f5a8e79ec626a78a6ce960cc2b684ac27e348eae160a`). Archive remains historical and is not current-source-aligned.

No archive was rewritten, rebuilt, installed or activated. A new package successor is deferred because release manifest/package pins are immutable in this task and the six external RC.23 gates remain open. Full local tests passing do not override the RC.71 source-alignment failure, missing live attestations, unresolved Phase 2 contract, production trust/anchor or drain authority. Rollout remains `BLOCKED`; `canActivateNow=false`.

## Execution Plan Candidate self-consistency verifier — 2026-10-31

The low-level `WorkflowStore` boundary previously called `verifyAdaptiveGoalExecutionPlanCandidateHash()`, which verified only the outer candidate envelope hash. A modified nested compiler plan, evidence snapshot or reviewed intent could therefore pass that helper if its outer hash were recomputed. Higher-level RC.71 readback also rebuilds the candidate from current source, but the shared low-level verifier should not treat an outer digest as a complete internal-consistency check.

The verifier now fails closed unless all of the following agree: candidate envelope; embedded `validateExecutionPlan` and compiler `plan_hash`; reviewed task-input contract hash; exact action-intent bindings reconstructed from that contract versus compiler child tasks; evidence snapshot versus reviewed evidence provenance; source/evidence, role-contract, artifact-schema, dependency and semantic digests; candidate fingerprint/ID; and exact review-only gates. It remains a structural self-consistency check, not a signature or source-attestation authority; fresh server readback and reviewer attestation checks remain required.

Regression coverage rehashes the outer candidate after changing compiler arguments, evidence content hash and reviewed action intent. All three forged envelopes are rejected. Focused validation: `node --test tests/test-adaptive-goal-execution-plan-candidate.js tests/test-adaptive-goal-store-dispatch-guard.mjs tests/test-agg-v2-event-callers.mjs` — exit 0, 22/22. `git diff --check` — exit 0. `npm run docs:check` — exit 0, 209 Markdown files, 505 local links, 75 MCP tool references.

The changed candidate source hash required a new source-inventory successor; historical register v0.3 remains untouched. Inventory v4 `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T063000Z-v4.json`, SHA-256 `de66d8c7784a6290c8287cd4268e18a97c286159ea367723ccde24567b775311`; register v0.4 `docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.4.json`, SHA-256 `740b40d60ea93c7da98564a1640ce3840ae9a9774705abe3b58b04c11a65987a`. Inventory remains 88 files/116 callsites; no producer tuple changed. This does not close V2-01.

Full `npm test`: exit 0. Log `/tmp/runalith-agg-candidate-verifier-full-test-20261031T073000Z.log`. This includes source-drift inventories, trust/approval/readback suites, Goal/Idea/Plan/Execution Graph integration, candidate tamper negatives, benchmark v160, rollout and acceptance consistency. `npm run docs:check`: exit 0, 209 Markdown files/505 local links/75 MCP references. `git diff --check`: exit 0. No archive, production database, live workflow, trust ledger or host process was changed.

## Persisted task-node evidence completeness — 2026-10-31

The caller-graph schema and Plan Graph projection already treat both `task` and `experiment` as executable action nodes, but the persisted Goal/Idea store enum did not accept `task`. This left the persisted route unable to represent a first-class task action and the verifier's per-action evidence gate covered only `experiment`. A non-empty graph-level evidence manifest could therefore coexist with an evidence-free task step if the task type were introduced through another source.

The store now accepts persisted `task` nodes and aligns `supports`/`enables` source/target allowlists with snapshot semantic revalidation. This is an application-level enum extension over the existing unconstrained SQLite `TEXT` column; no DDL migration, data rewrite or live DB access was performed. The snapshot verifier now requires every `task` and `experiment` action node to declare its own durable `artifact://` reference, independently resolve producer task/role/result/completion lineage, and rejects either action type as the graph start. Existing signed snapshot, trust-root, nonce, expiry, transaction and durable readback gates remain unchanged. No hash is promoted to authenticity, independent adjudication or external trust.

Regression coverage proves (a) unrelated evidence elsewhere in the same graph cannot satisfy an evidence-free task, (b) a task with independently resolved producer artifact can pass the signed snapshot test harness and project into an authenticated Plan Graph draft with exact source-node/evidence binding, (c) `supports`/`enables` accept task as either endpoint, and (d) a legacy unconstrained node table can be reopened without rebuild while preserving old nodes and accepting a new task. Test keys and in-memory DBs remain isolated test fixtures, not production trust.

Targeted validation (all executed after the final task-evidence assertions):

- `node tests/test-adaptive-goal-knowledge-store.js && node --test tests/test-adaptive-goal-knowledge-verifier.mjs` — exit 0; store tests and legacy-schema compatibility passed; verifier 14/14. Log `/tmp/runalith-agg-task-evidence-store-verifier-final.log`.
- Integrated Goal/Idea → Plan → Execution regression command (`node --test` over knowledge verifier, graph, execution readiness, execution proposal, execution-plan candidate, reviewer identity, approval subsystem, store dispatch guard and current-scope producer E2E) — exit 0, 106/106. Log `/tmp/runalith-agg-task-evidence-integrated-final.log`.
- `npm run test:agg-phase4` — exit 0, 57/57. Log `/tmp/runalith-agg-task-evidence-phase4-final.log`.
- `npm run test:agg-codegraph-regression` — exit 0, 33/33. Log `/tmp/runalith-agg-codegraph-task-evidence-final.log`.
- `node --test tests/test-adaptive-goal-benchmark.mjs` — exit 0, 15/15 on v161. Log `/tmp/runalith-agg-benchmark-v161-test-final.log`.
- `node benchmarks/adaptive-goal-graph/run-benchmark.mjs --fixture fixtures/recovery-verifier-v161.json` — exit 0; 50 measured records and 5 summaries. Output `/tmp/runalith-agg-benchmark-v161-run-final.json`.
- `git diff --check` — exit 0.
- `npm run docs:generate-reference` — exit 0; regenerated `docs/MCP_REFERENCE.md` from the disposable RC.71 source runtime's actual `tools/list` schema (75 tools), including the new `task` enum. The generator pins all DB/workspace paths to a disposable temporary directory and removes it after use; no production DB was opened.
- `node scripts/check-docs.mjs` — exit 0; 209 Markdown files / 505 local links / 75 MCP references. Log `/tmp/runalith-agg-docs-check-final.log`.

Benchmark successor `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v161.json` (provenance revision 143) advances v160 and preserves the frozen schema-v118 ground-truth oracle, task/node/edge identities, evidence requirements and scoring rubric. v160 remains byte-for-byte unchanged (SHA-256 `0b8911fc2dec163c068c7136aba987a8533e6c18a7f7d50dc9f53086f3bdc4c3`); v159 remains unchanged (`c9cda13ac00112153d8601498fe59cf18465834d6af6656fd970ed573b46ee24`); v158 remains unchanged (`ab7c5b3e51f57875bbfb5f41ab0193c8788d0436646352d4ebeaa7ad0dab2cf9`). v161 pins the changed source/test/docs and exact v160 predecessor; source-pin verification and final v161 SHA-256 are recorded in the adjacent machine-readable preflight artifact. Local-only evidence; no independent release provenance.

Machine-readable local acceptance record: `artifacts/adaptive-goal-graph/plan-task-evidence-preflight-20261031-v1.json`. It binds exact source/fixture hashes, predecessor lineage, executed command/exit evidence, validation freshness, docs-check HOLD and each external gate disposition. The report is local integrity evidence only.

This slice closes only persisted `task` type support and per-action evidence completeness. It does not establish a production Goal/Idea attestation, authenticated live Plan Graph snapshot, independent reviewer, external trust anchor, immutable live plan pin, or production dispatch authority. Current live Goal/Idea evidence remains invalid (`source_hash_mismatch`); no live plan was promoted. D-01 cross-database TOCTOU remains OPEN: separate workflow/trust SQLite files still lack a proven atomic identity-bound transaction/lock/fencing contract. No migration is authorized; requirements remain canonical DB identity, host-approved consolidation plan, writer fencing, transaction/crash/rollback proof, external anchor continuity and owner approval.

The six RC.23 release blockers remain OPEN. Phase 2's checked-in source contract freezes only the count of 71 paths; the exact owner-signed path list is absent, so no truthful per-path diff can be computed. The known discrepancy is candidate inventory count versus the frozen 71-path requirement (the historical RC.71 engineering archive has 109 ZIP entries and fails current source alignment); do not infer that all ZIP entries are contract paths or trim/rename files. Contract owner must supply signed canonical 71 paths, ordering/normalization, source-tree binding, custody policy and controlled-builder receipt before path-by-path comparison. Independent release evidence needs signed build/rebuild/verifier/approval receipts; production trust needs five administrator-issued domain configurations plus effective host readback; external anchor needs independently operated monotonic head/continuity receipts; workflow drain needs per-job owner/provider dispositions; task drain needs per-task process/run/attempt/result/artifact/lease/fencing dispositions and explicit authority. Missing lease/PID data does not authorize lifecycle action. Rollout remains `BLOCKED`, `canActivateNow=false`.

RC.71 archive recheck: `dist/runalith-1.0.9-rc.71-engineering-successor-20261030.mcpb`, SHA-256 `fe1fc383cb2e64fcf0fc817fb0ed668137c922bd1e3b8052bf64fcf4fd0f8da2`, 109 ZIP entries, `unzip -t` exit 0. Current-source alignment exits 1 at `scripts/build-agg-live-remediation-plan.mjs` (source SHA-256 `67d77e37f7687980020abb27f7cb028e3a20ff08be96e8f92e027cc85046576f`; archived SHA-256 `fcb3d9e8f2bbee147aa0f5a8e79ec626a78a6ce960cc2b684ac27e348eae160a`). The versioned RC.71 entrypoint also differs: current source `12a8b3349bea1d6ae2347acb9b324d59c3686306961ce14a92c5f732038af57a`; archive `44c489cbf7e7ee2d1defd51065401de774d736bdc65bf98a05e86d49b243aed7`. Archive was not rebuilt or modified.

## Persisted Plan Graph approval, immutable-plan recovery and reviewer source binding — RC.71 v144

### Defects and implementation

The prior `WorkflowStore.compileExecutionPlan()` wrote `workflow_plans` and then `workflow.plan_compiled` without owning a transaction when invoked outside the approval transaction. If event insertion failed, an orphan immutable plan row could survive; subsequent `getExecutionPlan()` correctly rejected the missing canonical event, but recovery had no safe way to repair the partial write. A new fault-injection test was first run RED: `/tmp/runalith-plan-atomicity-red.log` (non-zero; injected event failure left the plan row). The method now acquires `BEGIN IMMEDIATE` when no caller transaction exists, reads the proposal under the writer lock, writes the immutable plan row and canonical event, performs exact `getExecutionPlan()` readback, and commits only after readback succeeds. Any error rolls back the entire standalone operation. Existing caller-owned approval transactions are preserved; no nested `BEGIN` is issued.

Plan Graph approval now has a host-configured `setAdaptiveGoalPlanApprovalGuard`. `WorkflowStore.approve()` re-runs the current persisted Plan Graph/Goal-Idea source verifier after compiling and reading back the immutable review plan, while the approval transaction still owns the SQLite writer lock. The callback binds the exact current proposal hash, source fingerprint, source graph hash, draft hash, Plan Graph binding hash and persisted immutable plan hash. The same verifier runs on an exact already-approved retry before returning idempotent success. Missing guard or any mismatch fails closed. This is local same-database writer fencing; it does not solve D-01 across the separate trust configuration database.

Reviewer-attestation idempotent ingestion now requires exact source attestation/evidence/trust-root/provider binding equality and `executionReviewReady === true` on durable readback. A byte-identical signed retry cannot report success when current source snapshot or semantic review readiness has changed.

### Regression coverage

- `tests/test-workflow-plan-structural-contract.js`: injected `workflow.plan_compiled` event failure leaves neither plan nor event; retry persists both; a second SQLite connection reconstructs the same plan hash after close/reopen.
- `tests/test-adaptive-goal-current-scope-producer-e2e.mjs`: approval-row trigger advances a persisted Goal/Idea revision after MCP handler preflight; the in-transaction final verifier rejects it, and approval row, plan pin and injected revision all roll back. A subsequent valid approval succeeds. Two independent runtime processes concurrently retry the exact Plan Graph approval; no duplicate approval, plan row or compiled event is created. Existing Plan Graph proposal restart readback remains covered.
- The same E2E restarts the source runtime after reviewer attestation ingestion, then re-resolves persisted event bytes, reviewer identity and trust ledger; `reviewerIdentityVerified` and `executionReviewReady` remain true only after re-verification.
- `tests/test-adaptive-goal-reviewer-identity.js`: invalid semantic-readiness and changed source-snapshot readbacks are rejected on exact signed retry; exact current retry remains idempotent.
- Existing current-scope E2E retains negative coverage for source mutation, missing evidence, invalid signature, wrong scope, replay, expiry, reviewer authority, artifact mutation, stale source and review-only Plan Graph wrapper. Its reported `dispatched=true` occurs only in its disposable private test database; no production dispatch occurred.

### Validation actually executed

- `node tests/test-workflow-plan-structural-contract.js` — exit 0, `WORKFLOW PLAN STRUCTURAL CONTRACT PASS`. Log `/tmp/runalith-plan-atomicity-final.log`.
- `node --test tests/test-adaptive-goal-reviewer-identity.js` — exit 0, 15/15. Log `/tmp/runalith-reviewer-readback-final.log`.
- `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs` — exit 0, 1/1; includes independent process concurrency, restart readback and stale-source transaction rollback. Log `/tmp/runalith-agg-plan-approval-recovery-e2e-final.log`.
- `npm run test:agg-phase4` — exit 0, 57/57. Log `/tmp/runalith-agg-plan-persistence-phase4-final.log`.
- `node --test tests/test-agg-v2-event-callers.mjs` — exit 0, 8/8. Log `/tmp/runalith-agg-v2-event-callers-final5.log`.
- `node --test tests/test-agg-v2-sql-mutation-audit.mjs` — exit 0, 12/12. Log `/tmp/runalith-agg-v2-sql-audit-final.log`.
- `node --test tests/test-adaptive-goal-benchmark.mjs` — exit 0, 15/15 on v162. Log `/tmp/runalith-agg-benchmark-v162-test-final.log`.
- `node scripts/check-docs.mjs` — exit 0, 209 Markdown files/505 local links/75 MCP tool references. Log `/tmp/runalith-agg-plan-persistence-docs-final.log`.
- `git diff --check` — exit 0. Log `/tmp/runalith-agg-plan-persistence-diff-check-final.log`.

Initial inventory/register successor attempts v0.5 through v0.5.4 and early focused runs exposed incorrect line remapping/direct-writer metadata; these intermediate artifacts and failure logs remain preserved, not selected by tests. The selected v0.5.5 register passes the exact 116-caller/source tuple check. The SQL audit's selected v5 inventory and v0.5.3 event query register pass all 12 tests. These are source-only drift records, not an authorization registry or projection manifest.

### Candidate and source lineage

Candidate successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v162.json`, provenance revision 144, schemaVersion 118, 206 source pins/0 mismatches. Its final digest is recorded in the machine-readable preflight artifact. It preserves the exact v161/v160 frozen ground-truth oracle, task/node/edge identities, evidence requirements and scoring rubric. v161 remains byte-for-byte unchanged (SHA-256 `82b14a32a38180296212f488926fb766e5772c2b7588970c86226f3907ae1f63`); v160 remains unchanged (`0b8911fc2dec163c068c7136aba987a8533e6c18a7f7d50dc9f53086f3bdc4c3`). Source pins are local integrity evidence only.

Current source hashes at this revision: versioned RC.71 entrypoint `d4267eecf1ac0560046977741b9bde8f5e9ea9d052b0d01a1942e6913381c93b`; `src/runtime/job-store.js` `159ccf80aae8c580222371fbb7e8841fe0351ad7a603e5a9c703523c208b989a`; reviewer identity `c9a369b377ddb2e6670efad6d11c732bed813943b15af0ab89e0105aae1a25e3`.

V2 source inventory successors for this exact source: RecordEvent v5 `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T065755Z-v5.json` (88 files/116 callsites); current caller register v0.5.5 `docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.5.5.json`; direct SQL inventory v5 `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261031T065755Z-v5.json` (159 files/1,464 callsites/242 data writes); event query register v0.5.3 `docs/agg-external-checkpoint-v2-event-query-register-20261031-v0.5.3.json` (193 event SQL callsites). Four new direct-SQL callsites are transaction-control statements in the standalone plan transaction wrapper; no data writer or RecordEvent producer was added. Details and limitations are in `docs/agg-external-checkpoint-v2-implementation-tooling-20261030.md`.

Machine-readable successor: `artifacts/adaptive-goal-graph/plan-task-evidence-preflight-20261031-v2.json` (local-only). It records source/candidate/archive hashes, executed validation commands and exits, evidence freshness, inventory lineage, six gate dependencies, D-01 requirements and rollout disposition. It does not attest external trust or host state.

### Remaining acceptance limits and release disposition

The local Plan Graph path now verifies persisted proposal/source/plan state at approval commit and exact retry, and its plan row/event pair is atomic when compiled standalone. Goal/Idea snapshot cryptographic authenticity still depends on the configured trust root and independently verified signer; the test trust root remains test-local. The separate trust database still leaves D-01 OPEN. No production DB was opened or changed.

All six RC.23 blockers remain OPEN:

1. `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — the authoritative signed canonical 71-path manifest, normalization/order rules and source/candidate binding are still absent. Exact path-level discrepancies remain NOT COMPUTABLE; archive entry count is not a substitute.
2. `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — requires controlled-builder provenance, independent rebuild/verifier receipts and candidate-bound release approval.
3. `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — requires five trust-domain administrators, key custody/rotation/revocation evidence and authenticated effective-host readback.
4. `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — requires independent checkpoint operator, host-pinned verifier root and signed monotonic-head/continuity receipts.
5. `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — requires per-job owner/provider/runtime terminal disposition and explicit drain authority.
6. `RUNNING_TASKS_MUST_DRAIN` — requires per-task process/run/attempt/result/artifact/lease/fencing disposition and explicit drain authority.

D-01 remains OPEN until canonical database identity/generation, owner-approved consolidation plan, complete writer inventory, host writer fencing, lock ordering/`BEGIN IMMEDIATE`, WAL/checkpoint barriers, crash/partial-commit/rollback/retry proof and external anchor continuity are evidenced and authorized. The Phase 2 path list cannot be inferred. No production migration, approval, dispatch, drain, trust-root/ledger change, package install or activation was performed. RC.23 archive remains unchanged; RC.71 archive remains source-misaligned and was not rebuilt. Rollout remains `BLOCKED`, `canActivateNow=false`.

Final v144 freshness recheck after dossier/candidate pin refresh: `node scripts/check-docs.mjs` exit 0 (209 Markdown/505 local links/75 MCP references), log `/tmp/runalith-agg-plan-persistence-docs-final2.log`; `node scripts/verify-mcpb-source-alignment.mjs --bundle dist/runalith-1.0.9-rc.71-engineering-successor-20261030.mcpb` exit 1, log `/tmp/runalith-agg-rc71-source-alignment-v144-final.log`; `unzip -t` on that same RC.71 archive exit 0, log `/tmp/runalith-agg-rc71-zip-v144-final.log`. The first source mismatch remains `scripts/build-agg-live-remediation-plan.mjs` (source `67d77e37f7687980020abb27f7cb028e3a20ff08be96e8f92e027cc85046576f`, archived `fcb3d9e8f2bbee147aa0f5a8e79ec626a78a6ce960cc2b684ac27e348eae160a`). Current RC.71 entrypoint source is `d4267eecf1ac0560046977741b9bde8f5e9ea9d052b0d01a1942e6913381c93b`, while archived entrypoint remains `44c489cbf7e7ee2d1defd51065401de774d736bdc65bf98a05e86d49b243aed7`. RC.71 archive SHA-256 remains `fe1fc383cb2e64fcf0fc817fb0ed668137c922bd1e3b8052bf64fcf4fd0f8da2`; RC.23 archive SHA-256 remains `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`. Neither archive was modified.

## Reviewer ingestion error-code and cross-process replay recovery — 2026-10-31

The reviewer ingestion path called the shared `fail(message, code)` helper with arguments reversed. Existing tests matched the symbolic code in the formatted message, but `error.code` held descriptive text. This broke stable programmatic classification for replay, stale candidate, invalid shape, lifecycle, readback and persistence failures. Corrected all ingestion helper calls to preserve their stable `AGG_REVIEWER_ATTESTATION_INGEST_*` code values; cryptographic checks, nonce rules, source bindings and readiness requirements are unchanged.

Added a disk-backed, two-process regression: a parent connection holds `BEGIN IMMEDIATE`; two independent Node runtimes open workflow/trust DBs and signal immediately before their own `BEGIN IMMEDIATE`. Parent releases only after both pre-BEGIN markers. Exactly one signed assertion wins; the other returns `error.code === AGG_REVIEWER_ATTESTATION_INGEST_REPLAY`. Both DB handles are closed/reopened; persisted winner signature/identity verifies, exact retry remains idempotent, and loser nonce remains rejected. All state and trust keys are disposable test fixtures. Because `DatabaseSync.exec()` blocks synchronously, the marker is immediately before the call; it cannot independently prove both OS processes are already blocked inside SQLite at the same instant.

Focused validation:

- `node --test tests/test-adaptive-goal-reviewer-identity.js` — PASS 16/16.
- `node --test tests/test-agg-v2-event-callers.mjs tests/test-agg-v2-sql-mutation-audit.mjs` — PASS 20/20. New source inventory successors v6/v0.5.6 and v6/v0.5.4 preserve 116 RecordEvent tuples and 193 event SQL callsites; no producer or SQL operation semantics changed.
- Full `npm test` attempt — FAIL, exit 1. Two source-drift regressions correctly rejected stale v0.5.5/v0.5.3 inventory pins after the reviewer source changed. This is preserved failure evidence, not a runtime regression. Successor inventories/registers were generated and selected by tests; full suite must be rerun against those successors.

Benchmark fixture successor v164 is complete: benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v164.json; schema version 120, provenance revision 146, 212 source pins, zero mismatches. Exact digest is recorded in machine-readable preflight v3.

## RC.72 local engineering successor — 2026-10-31

The immutable RC.23 archive was not changed. RC.71 archive was not changed; its historical source-alignment failure remains recorded above. To carry the current three-graph implementation and reviewer-ingestion correction in a new versioned artifact, package metadata was advanced from `1.0.9-rc.71` to `1.0.9-rc.72` and a new entrypoint was created at `server/index-v1.0.9-rc.72-versioned-approval-subsystem-20261031.js` (byte-identical to the RC.71 entrypoint source). New local candidate:

- `dist/runalith-1.0.9-rc.72-engineering-successor-20261031.mcpb`
- SHA-256 `88aa3bc990834c897bb6216c7f8e1b2ae0d6b6b308bffeb8730a0d5d5ee14c6b`
- Size 1,007,696 bytes; ZIP entries 109; MCP tools 75.
- Source snapshot SHA-256 `f85ee2f4b755919134e073dc2f47aad547fc42be71bcf569c7a26e3f40625370`.
- `MCPB_SOURCE_ALIGNMENT=PASS`, exact archive-entry bytes match current dirty-tree sources; `unzip -t` PASS.
- Extracted runtime smoke: initialize + tools/list 75/75; extracted package tool schemas 75/75.
- Extracted three-graph E2E: nine typed producer artifacts → nine-node Plan Graph → durable Execution Graph proposal; exact lineage, immutable plan pin, reviewer identity and isolated approval/dispatch checks PASS. Negative controls block unregistered references and preserve non-authorizing source boundaries.
- Extracted reviewer suite includes independent-process nonce race and DB restart recovery; PASS.
- Build command: `PLUGIN_BUNDLE_OUT=dist/runalith-1.0.9-rc.72-engineering-successor-20261031.mcpb bash scripts/package-runalith-mcpb.sh`, exit 0; log `/tmp/runalith-rc72-package-build-20261031.log`, SHA-256 `0a7b4b298d54dc61a5520e3a5440e4f20a2cf36726a8fa4ff4af67bd898e6875`.
- Independent build receipt: NOT PRESENT. Independent builder/verifier/release approval: NOT PRESENT. Source tree was dirty. The package script explicitly reported `release_eligibility=BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`.

RC.72 is a local engineering successor only. It is not the RC.23 candidate, not independently authenticated, not production-ready, not installed or activated. The RC.23 Phase 2 exact 71-path owner contract remains OPEN; 109 ZIP entries do not prove 71-path membership. RC.71 remains source-alignment FAIL and untouched.

## Integrated regression and repository governance snapshot — 2026-10-31

- Full npm test after RC.72 package identity, reviewer writer-fence regression, selected v6 inventories and benchmark v164: exit 0; 29 Node test runs / 421 assertions passed, zero failed. Log /tmp/runalith-agg-three-graph-full-test-rc72-v164-final.log, SHA-256 6742a9bdfaeb6633d36c252a776a0c05a0b450f519c9e6a44e5a295ab5f8c052.
- `node --test tests/test-adaptive-goal-reviewer-identity.js`: 16/16 PASS, including parent-held writer fence, two child pre-BEGIN markers, stable replay `error.code`, close/reopen, exact retry and replay rejection.
- `node --test tests/test-adaptive-goal-benchmark.mjs`: 15/15 PASS against v164 after package metadata/entrypoint update.
- `node --test tests/test-agg-v2-event-callers.mjs tests/test-agg-v2-sql-mutation-audit.mjs`: 20/20 PASS. RecordEvent v6 has 88 files/116 callsites; semantic tuples unchanged. Direct SQL v6 has 159 files/1,464 callsites/242 data writes; operation classes unchanged. Event query v0.5.4 retains 193 callsites (189 readers, 3 writers, 1 schema bootstrap).
- node scripts/check-docs.mjs: exit 0; 209 Markdown files, 506 local links, 75 MCP references. git diff --check: exit 0.

Live GitHub governance read-only snapshot: milestone #1 has 13 open issues (#32–#44). Project #2 has #32 and #38 `In Progress` / `Needs Evidence`; #33–#35 are `Todo` / `Blocked`; #36–#44 are `Todo` / `Blocked` under the recorded dependency graph. Issue bodies and Project `Dependencies` agree. Native GitHub `blocked_by` links are empty for #32–#44; this absence is recorded, not used to erase Project dependency edges. No issue, milestone or project field was modified. Project Owner retains all compatibility, trust-boundary, acceptance and release decisions.

Current implementation acceptance is local-only: three-graph integration and isolated security/lifecycle regressions PASS. Authenticated production current snapshot, host-managed trust, external checkpoint continuity, independent release provenance, owner-signed exact 71-path contract and authorized workflow/task drains remain NOT VERIFIED or OPEN. D-01 remains OPEN; no cross-database migration was attempted. Rollout remains `BLOCKED`, `canActivateNow=false`.

## RC.72 final source-aligned build v2 — 2026-10-31

After strengthening the reviewer nonce concurrency regression with a parent-held SQLite writer fence and two child pre-BEGIN markers, a second RC.72 build was created at a new path; the first RC.72 archive remains preserved as historical build v1.

- `dist/runalith-1.0.9-rc.72-engineering-successor-v2-20261031.mcpb`
- SHA-256 `a1f2a7cce41e21ef66f37f21c0856a5b656838e41287f92b3b436d9b1bb078f1`; size 1,007,947 bytes.
- Source snapshot SHA-256 `d138f2c08f2b41ba86f2bfbe7fa8392d1fb6d11811caeecee2b378adab0cb910`; 109 entries; 75 MCP tools.
- `MCPB_SOURCE_ALIGNMENT=PASS`, exact archive-entry bytes; `unzip -t` PASS.
- Package build exit 0; log `/tmp/runalith-rc72-package-build-v2-20261031.log`, SHA-256 `d1ad43ae5fec7746d036d8f7008602d0914ae9aafac5a052d85122155f4d2f0a`.
- Extracted reviewer regression with parent-held writer fence: PASS; three-graph producer → Plan Graph → Execution Graph E2E: PASS in isolated DB; production authority remains false.

The build script reports `source_provenance=DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT` and `release_eligibility=BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`. v2 was source-aligned at build time and is now a preserved historical snapshot; v3 below is current. RC.23 and RC.71 remain unchanged.

## RC.72 current local build v3 — 2026-10-31

The temporary duplicate RC.72 versioned entrypoint copy was removed. Package version remains 1.0.9-rc.72; package.json.main, runtimeEntryPoint, and plugin/manifest.json.server.entry_point consistently reuse unchanged server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js. Runtime implementation changes reside in src/runtime; server entrypoint source itself did not change. This avoids duplicating all recordEvent() callsites under a second versioned source path.

- Current archive: dist/runalith-1.0.9-rc.72-engineering-successor-v3-20261031.mcpb
- SHA-256 b3b30c37f90cfbc9159e097619e6df4b5f6c2c9aba30ca20e1e1d564e274f0b6; size 1,007,949 bytes.
- Source snapshot SHA-256 6159d92897ee2694c4fc3d86998097b1ec2c2bc94ad350979c00887c29c95255; 109 entries; 75 MCP tools.
- MCPB_SOURCE_ALIGNMENT=PASS, exact archive-entry bytes; unzip -t PASS.
- Package build exit 0; log /tmp/runalith-rc72-package-build-v3-20261031.log, SHA-256 b4217f1da8004ca8155ce49d7f9be9692a9d89d2ad0babe7f9f46b809aa1874b.
- Extracted reviewer regression with parent-held writer fence: PASS; extracted three-graph producer to Plan Graph to Execution Graph E2E: PASS in isolated DB. productionAuthorityGranted=false.

The v7 RecordEvent/direct-SQL inventory outputs and event-query v0.5.5 are preserved but unselected drafts. They were generated while a temporary RC.72 entrypoint copy was active. RecordEvent inventory had 88 files/116 callsites; the attempted register comparison aborted because its comparator omitted the inventory-only invocation field, not because semantic tuples changed. The active entrypoint was subsequently kept at the unchanged RC.71 path; therefore v7/v0.5.5 are not current selections. Current tested selections remain RecordEvent inventory v6/register v0.5.6 and direct-SQL inventory v6/event-query register v0.5.4. The temporary duplicate source file was removed; no pre-existing source was overwritten.

v3 is a local dirty-tree source-aligned package only. It has no authenticated controlled-builder receipt, independent verifier result or candidate-bound release approval. Not installed or activated. Rollout remains BLOCKED.
## Final failure reconciliation and preflight record — 2026-10-31

- Initial full-suite source-inventory attempt failed because v0.5.5/v0.5.3 source pins were stale after reviewer source changes. Replaced only with tested v6/v0.5.6 and v6/v0.5.4 successors; original failures and intermediate drafts preserved.
- Initial reviewer concurrency barrier attempt hung because READY newline escaping did not match. Corrected escaping; then strengthened test with a parent-held BEGIN IMMEDIATE fence and two child pre-BEGIN markers. Focused reviewer suite passes 16/16. The synchronous SQLite API cannot prove both OS processes are already blocked inside SQLite at the same instant; this limitation is explicit in the test/dossier.
- First RC.72 full-suite attempt failed because package.json.main still referenced the RC.71 path while runtimeEntryPoint temporarily referenced a duplicate RC.72 copy. Corrected package identity: version 1.0.9-rc.72, main/runtimeEntryPoint/manifest entrypoint all consistently reuse unchanged RC.71 server entrypoint. Current RC.72 v3 archive passes exact source alignment.
- First v164 benchmark run failed because two provenance claims still said v163. Claims corrected; v164 benchmark passes 15/15.
- v7 RecordEvent comparator attempt aborted on omitted invocation field; 116 callsites and source path mapping otherwise preserved. v7 inventories and query register remain unselected drafts.
- Final full npm test is 421/421 PASS; final docs check 209/506/75 PASS; diff check PASS.
- Machine-readable final report: artifacts/adaptive-goal-graph/plan-task-evidence-preflight-20261031-v3.json. It records exact source/archive hashes, command/exit evidence, historical failures, project policy snapshot, six release blockers and D-01.

No test-local trust root, source hash, ZIP integrity result, package source-alignment result or local build receipt is external authenticity evidence. Production trust, external checkpoint, independent release verification and authorized drains remain NOT VERIFIED. Rollout BLOCKED; canActivateNow=false.

## D-01 private-file boundary fault injection and RC.72 v4 — 2026-10-31

A focused local fault-injection test was added to `tests/test-adaptive-goal-knowledge-verifier.mjs`. It uses two distinct on-disk SQLite files (`workflow.db` and `agg-trust-configuration.db`) and exercises the current verifier's cross-database ordering without changing either production database or migrating the trust ledger:

- Injected workflow verification-row insert failure: trust configuration history observation remains committed in the separate trust DB while the workflow verification row rolls back. This demonstrates the current split-commit boundary; it is not atomicity.
- Reopen both DBs, hold `BEGIN IMMEDIATE` on a second trust-DB connection, and retry: verifier fails closed with `database is locked` before writing a workflow attestation.
- Release the trust writer lock and retry: the same signed test attestation recovers, persists once, and exact retry is idempotent without duplicating the already committed trust observation.
- All keys, DB files and trust configuration are disposable test fixtures. No production trust root, ledger, DB or host was accessed.

Validation:

- `node --test tests/test-adaptive-goal-knowledge-verifier.mjs` — PASS 15/15, including the new private-file D-01 fault.
- The same test run from the extracted RC.72 v4 package — PASS 15/15; log `/tmp/runalith-rc72-v4-extracted-d01-test.log`, SHA-256 `e39bb7036782a67f68c097f071f06308ded0e70d36df4063fb5f840f71efa991`.
- Full `npm test` — exit 0; 29 Node test runs / 422 assertions, zero failed. Log `/tmp/runalith-agg-three-graph-full-test-rc72-v164-d01-final.log`, SHA-256 `4a361304fe60d1628ebad0360d9217efe98894aa2818b46a9b4b37eb25c7bd81`.
- `node --test tests/test-adaptive-goal-benchmark.mjs` — PASS 15/15 against benchmark v164.
- `node scripts/check-docs.mjs` — exit 0; 209 Markdown files, 506 local links, 75 MCP references.
- `git diff --check` — exit 0.

New local engineering archive:

- `dist/runalith-1.0.9-rc.72-engineering-successor-v4-20261031.mcpb`
- SHA-256 `ecc49145c7a520d80047da5f616d304d8da189e7872c672723b2c40057023b7a`; 109 ZIP entries; 75 MCP tools.
- `unzip -t` — exit 0.
- `node scripts/verify-mcpb-source-alignment.mjs --bundle dist/runalith-1.0.9-rc.72-engineering-successor-v4-20261031.mcpb` — exit 0; `MCPB_SOURCE_ALIGNMENT=PASS`, exact dirty-tree archive-entry bytes; source snapshot SHA-256 `c5823f44d6e09a4333b8f1fa957adb7c1e11d53de6917ae3c68fec6c729f24a5`.
- Build log `/tmp/runalith-rc72-package-build-v4-20261031.log`, SHA-256 `1ef4049969a9b227a512a8beb8ebd5318bd5ddf731da65326aeef74c2bc45803`.

This test is deliberately evidence of the unresolved D-01 boundary: one database can commit while the other rolls back. It proves a local fail-closed behavior for trust-writer contention and successful retry after reopen, but does not provide cross-database atomicity, canonical DB identity/generation, host-wide writer fencing, WAL/checkpoint barriers, restore-epoch continuity, or external monotonic anchoring. D-01 remains OPEN; no migration/remediation is authorized. The Phase 2 71-path contract and all six RC.23 release gates remain OPEN. RC.23 and historical RC.71 archives remain unchanged. RC.72 v4 is a dirty-tree local engineering artifact, not an independently authenticated build or release candidate. No installation, activation, approval, dispatch, drain or production mutation occurred. Rollout remains `BLOCKED`, `canActivateNow=false`.

### Extracted RC.72 v4 three-graph package E2E

The exact RC.72 v4 archive was extracted to a private temporary directory and its packaged `tests/test-adaptive-goal-current-scope-producer-e2e.mjs` was run against the extracted runtime, not the source-tree runtime:

- `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs` from the extracted package — PASS 1/1.
- Nine typed producer roles/artifacts, nine-node Plan Graph DAG, durable Execution Graph proposal, exact hash/lineage, isolated Goal/Idea attestation, reviewer identity, immutable plan pin and negative stale/unregistered/unverified-source cases passed.
- The E2E explicitly used private isolated SQLite state and disposable Ed25519 test trust. Its `dispatched=true` result is an isolated test transition only; it is not production dispatch or production authority.
- Log: `/tmp/runalith-rc72-v4-extracted-three-graph-e2e-final.log`.

This extracted-package test validates the packaged local integration surface only. It does not close any RC.23 release gate or D-01.

## D-01 process-termination recovery extension — 2026-10-31

The D-01 private-file regression now also exercises an actual child-process `SIGKILL` between the two database commits. The fixture creates two isolated files with the current observed connection profiles: workflow WAL / `synchronous=FULL` / `busy_timeout=5000`; trust DELETE journal / `synchronous=FULL` / `busy_timeout=0`.

- Child commits one trust observation, begins a workflow transaction, inserts a workflow attestation, then receives `SIGKILL` before workflow `COMMIT`.
- Independent reopen plus `PRAGMA integrity_check` confirms the trust observation survives and the uncommitted workflow attestation is rolled back.
- A second child is killed after inserting an uncommitted trust observation in the DELETE-journal database; reopen confirms that row is rolled back while the prior committed observation remains.
- A separate process contending on the trust writer receives `database is locked` under the current zero-timeout trust connection; no workflow write is attempted in that contention branch.
- The low-level retry branch uses unique keys / `ON CONFLICT DO NOTHING`, commits the workflow record once, then a second reopen confirms one trust row, one workflow row and intact databases. The preceding verifier-level fault test separately proves actual `verifier.attest()` fail-closed contention and exact application retry after reopen.
- Physical `dev`/`ino` are checked only to prove the test fixture uses distinct files. They are not a canonical logical database identity, generation, restore epoch or host custody proof.

Validation: `node --test tests/test-adaptive-goal-knowledge-verifier.mjs` — PASS 16/16. The new SIGKILL case is a deterministic lower-level SQLite process-crash/reopen test over disposable files, not a child-process invocation of the full verifier. It proves the observed split-commit outcome, rollback of an uncommitted WAL workflow row and an uncommitted DELETE-journal trust row, and persistence of a previously committed trust row. Its contention/idempotent SQL branch is synthetic; application-level fail-closed contention and retry are proven separately by the verifier-level trigger fault test. It does **not** exercise power-loss durability, real filesystem/controller cache behavior, every WAL checkpoint interleaving, complete host writer fencing, actual production `DatabaseSync` lifecycle, cross-database atomicity, or external monotonic continuity. The trust connection's `busy_timeout=0` remains an observed operational gap; no PRAGMA policy was inferred or changed.

The one-command local preflight now runs the full Goal/Idea verifier test file and reports the D-01 fault-injection/SIGKILL recovery result explicitly. The local preflight's existing SQL/event inventories remain source-discovery evidence only. RC.23 and RC.71 archives remain untouched. No migration, consolidation, approval, dispatch, drain, install, activation or production-state change occurred. D-01 remains OPEN; rollout remains `BLOCKED`, `canActivateNow=false`.

## RC.72 v5 local engineering successor — 2026-10-31

Because the D-01 regression and preflight automation changed implementation/test/tooling bytes, a new local package successor was built; RC.72 v4 and all historical archives were preserved:

- `dist/runalith-1.0.9-rc.72-engineering-successor-v5-20261031.mcpb` — SHA-256 `7a0b6518c0e8d7571c6e32e641ef21571530ea8c1f0ab0dfbaff363f62fe1d21`, 1,009,759 bytes, 109 ZIP entries, 75 MCP tools.
- `unzip -t` — PASS. `node scripts/verify-mcpb-source-alignment.mjs --bundle dist/runalith-1.0.9-rc.72-engineering-successor-v5-20261031.mcpb` — `MCPB_SOURCE_ALIGNMENT=PASS`, exact packaged dirty-tree bytes; source snapshot SHA-256 `c6bbd3c1abb970ec44337086b841b7382949e69885ef4d7e801b94e95a9d53b6`.
- Extracted package `node --test tests/test-adaptive-goal-knowledge-verifier.mjs` — PASS 16/16, including SIGKILL split-commit recovery.
- Extracted package `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs` — PASS 1/1; nine typed producers, nine-node Plan Graph DAG and durable Execution Graph proposal; isolated test trust/database only.
- Source tree `node --test tests/test-adaptive-goal-benchmark.mjs` — PASS 15/15 against v165; frozen oracle preserved. The benchmark test/fixture are source-tree engineering evidence and are not included in the MCPB package collector, so no extracted benchmark-test claim is made.
- Full `npm test` — exit 0 on current source. `node scripts/run-agg-v2-local-preflight.mjs` — `PASS_LOCAL_CHECKS_WITH_EXTERNAL_GATES_OPEN`, including D-01 16/16 and RC.23 historical DB restart test. `node --test tests/test-cos-automatic-send-check.mjs` — PASS 1/1.
- `node scripts/check-docs.mjs` — PASS, 209 Markdown files / 506 local links / 75 MCP references. `git diff --check` — PASS.

The package builder itself reports `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; no independent builder receipt, verifier result or candidate-bound release approval exists. This is a local engineering archive, not a release-authorized candidate. The extracted E2E's `dispatched=true` is a private test-only state transition and not production dispatch. No installation or activation occurred.

Benchmark fixture successor `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v165.json` preserves the frozen graph/scoring oracle, pins 213 source inputs and supersedes v164 without modifying it. Machine preflight `artifacts/adaptive-goal-graph/plan-task-evidence-preflight-20261031-v4.json` binds current source/candidate/test hashes and local-only outcomes. Phase 2 discrepancy artifact `artifacts/adaptive-goal-graph/phase2-frozen-71-path-contract-discrepancy-20261031-v1.json` remains `NOT_COMPUTABLE`: owner-signed exact 71-path manifest absent; no missing/extra/incompatible counts are inferred.

RC.23 archive SHA-256 remains `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; RC.71 archive remains unchanged and historically source-misaligned. All six RC.23 gates and D-01 remain OPEN. Rollout remains `BLOCKED`, `canActivateNow=false`.

## RC.72 v6 local engineering successor — 2026-10-31

The v5 package was superseded after the SIGKILL test gained a second crash boundary: an uncommitted trust observation in DELETE-journal mode is now killed before `COMMIT` and verified absent after reopen. v5 remains unchanged. v6 contains the final source/test bytes for this pass:

- `dist/runalith-1.0.9-rc.72-engineering-successor-v6-20261031.mcpb` — SHA-256 `ea776bb48e25d70bb20bf57cdbfa95af5fe7f3eb0b7b2380d037e1a9491d4318`, 1,009,859 bytes, 109 ZIP entries, 75 MCP tools.
- `unzip -t` — PASS. Source alignment — PASS exact packaged dirty-tree bytes; source snapshot SHA-256 `3ac881bc3d37259f6fae523646caf84fb498525a62c3ca05509b8714bd67091a`.
- Extracted v6 `node --test tests/test-adaptive-goal-knowledge-verifier.mjs` — PASS 16/16; includes both workflow WAL rollback and trust DELETE-journal rollback after process SIGKILL.
- Extracted v6 `node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs` — PASS 1/1; nine typed producers, Plan Graph DAG and persisted review-only Execution Graph proposal; isolated test trust/database only.
- Final source `npm test` — PASS, exit 0; full output SHA-256 `14031b028279ef37f13e1b89d869b59d742e342233f5e14e697f25a84a04fc72`. Final `node scripts/run-agg-v2-local-preflight.mjs` — `PASS_LOCAL_CHECKS_WITH_EXTERNAL_GATES_OPEN`, D-01 16/16 and RC.23 historical DB restart PASS; machine-readable output SHA-256 `a744fba00c871158185efd63a6ac6d58989f9d9f717e020739e908aa8074442c`.
- Source benchmark `node --test tests/test-adaptive-goal-benchmark.mjs` — PASS 15/15 on v165. Docs check and `git diff --check` rerun after dossier refresh — PASS.
- Candidate provenance remains local-only: dirty-tree byte alignment, no authenticated builder receipt, no independent verifier and no candidate-bound release approval. Not installed or activated.

The Phase 2 discrepancy artifact was refreshed to bind this v6 archive digest and source snapshot; it remains `NOT_COMPUTABLE` because the owner-signed exact 71-path manifest is absent. Machine preflight v4 and benchmark fixture v165 are refreshed against the v6 candidate identity and current dossier bytes. All six RC.23 gates and D-01 remain OPEN; rollout remains `BLOCKED`, `canActivateNow=false`.
