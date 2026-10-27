# Goal/Idea Graph → Plan Graph → Execution Graph — v48 integration follow-up

Date: 2026-10-27. This is an unsigned implementation/validation supplement, not a release approval, build attestation, or final evidence index. It does not supersede the immutable RC.15/RC.16 dossiers or grant production authority.

## Implementation and benchmark provenance

- Hardened `scripts/lib/external-trust-checkpoint-contract.mjs` so canonical payload and digest APIs reject non-inert JSON before reading type-specific fields. Accessors, hidden/accessor properties, decorated/sparse arrays, symbols, cycles, shared references and non-plain objects are rejected. Checkpoint response and continuity validation remains fail-closed.
- Added hostile-object regression coverage in `tests/test-external-trust-checkpoint-contract.mjs`.
- Added `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v48.json` as a successor to v47. It contains 64 source provenance records and preserves the v47 oracle/task graph. At that checkpoint the runner defaulted to v48; v48 is now preserved as a historical fixture after the v49 successor was added.
- v47 is immutable: SHA-256 `8764d590818b43a0c18758cff8a5b0b12f844268b5379671de3dae577eddd3d2`.
- v48 SHA-256: `43408b90ca7cb083bd90e00cdd34ec163ed6fa3e292b4a17739d999995e89065`.
- Current v48 provenance audit: 64 records, 0 source-pin mismatches. Historical v47 naturally records older source identities and is not expected to match all current source bytes.
- The nine prior benchmark failures had one root cause: the old fixture pinned checkpoint-contract SHA-256 `fe3f309b05eb677ef3c5e3919e45bb13b503e8da36fa50ad8ed91680e6739bc2`, while hardened source bytes hash to `94deff767ebf6b69acf92dc56b776271a4a9c128cc51ba804e2f39a3e2600a1b`. The other eight failures were cascades: the runner aborted on that provenance mismatch before the intended malformed-fixture/benchmark assertions ran. No expected hash was edited in v47.

## Validation observed for current worktree

- `npm test`: PASS at the v48 checkpoint before the follow-up Plan Graph source change, including benchmark suite 15/15, graph/trust/approval/dispatch E2E, reviewer identity, evidence lineage, workflow reconciliation and telemetry suites. The v49 follow-up validation is recorded below separately.
- `npm run test:phase2-security-regressions`: PASS. Its diagnostic retains the frozen inventory mismatch: candidate has 93 entries, contract count is 71.
- `npm run test:phase2-custody`: PASS 5/5, including candidate substitution, trust-root collision and frozen-count rejection.
- `npm run docs:check`: PASS; 97 Markdown files and 331 local links.
- `npm run site:check`: PASS; package metadata reports version `1.0.9-rc.16`, 74 tools.
- `git diff --check`: PASS.
- `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.16-candidate-20261027T1700.mcpb`: PASS. Isolated candidate SHA-256 `e28d9c46056bb315a11fb9022a46ab7af43def3b47747a649b71205e1e11d9bc`, 838,565 bytes, 93 archive entries, 74 manifest/runtime tools, local-only health OK. No installation performed.
- Source alignment for RC.16: `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`, 93 archive entries; report `/tmp/runalith-alignment-rc16-after-v48-20261027.json`, SHA-256 `42fe584981e024986364ac1cfd48677e98a7d0468cf12314ac84ad2c84112a7e`. This proves byte alignment only; worktree is dirty and authenticated build provenance remains absent.
- Offline benchmark v48 output: `/tmp/runalith-agg-benchmark-v48-final-20261027.json`, SHA-256 `c71631b7991269b2ac7e9525e06383a2264ab32bba0a03af9f0860532b5bac4f`; 50 records, 5 summaries, 64 provenance records, zero network/model calls. Evidence remains explicitly unverified by this benchmark.
- ZIP integrity: RC.8, RC.15 and RC.16 archives pass `unzip -t`.

## Candidate lineage observations

- RC.8 archive SHA-256 `e1f49add15aaac00fa6924abbf630e41da01e552cf4f1b72639d7eb4b77dd776`; it is historical and fails current source alignment at `README.md` (`source=1c6421eb7d4d69d323338fa5275b06c82654e7992ba140a98a43c41c1fdc831e`, archive=`94f8e5872363a7288495e24de61e7bff2f5a421e127b8980b5c05357cd9150da`).
- RC.15 SHA-256 `f11e0303c0929f6d145f53f2033ce8195c2da6e9061bde1372ce6d19706091d1`.
- RC.16 SHA-256 `e28d9c46056bb315a11fb9022a46ab7af43def3b47747a649b71205e1e11d9bc`.
- RC.15/RC.16 archives and historical fixtures were not overwritten. No new release candidate or final evidence index was created because independent release authority and frozen path authority are still missing.

## Operational state and mandatory blockers

Read-only rollout preflight exited 3 and returned `BLOCKED`, `canActivateNow=false`, `liveMutationPerformed=false`. It observed installed RC.11 process; local workflow DB integrity `ok`, 60 `EXECUTING` jobs, 61 running tasks, zero active task leases. Missing leases/stale timestamps do not prove workers are dead. Keep every affected record on `HOLD` until per-record owner/provider/runtime/event/attempt/result/artifact/completion evidence and owner-authorized lifecycle decision are verified.

Mandatory blockers remain:

- `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`: require signed builder receipt for exact candidate/source snapshot, independent verification predicate and separately authorized release approval.
- `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`: require independently administered versioned verifier and reviewer JSON configs, distinct provider identities/disjoint roots, host-owned runtime identity, effective-config attestation, freshness and rotation/revocation evidence.
- `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`: require host-managed external monotonic checkpoint authority with authenticated signature, continuity, freshness and restart/replay anti-rollback evidence. Local SQLite is not this authority.
- `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` and `RUNNING_TASKS_MUST_DRAIN`: require authoritative per-record drain/reconciliation. No bulk reset, retry, terminalization or redispatch.
- `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`: require authoritative signed 71-path manifest, canonical source commit/tree/snapshot and authenticated builder receipt. Do not infer paths from count or trim 93 entries.

## Safe next actions and acceptance criteria

1. Obtain the frozen manifest and builder receipt from the independently administered Phase 2/release authority. Verify signer identity, trust-root separation, signature, source commit/tree, exact archive bytes and all 71 paths. Keep blocked if any authority artifact is absent.
2. Provision verifier/reviewer configs through the host administrator, attest the effective configuration and validate external checkpoint continuity/freshness/rotation/revocation through the host-owned monotonic store.
3. Reconcile each active job/task with authoritative owner identity, provider run/session status, runtime process identity, lease/heartbeat, event/attempt/result/artifact/completion hashes and an auditable owner decision. Only then may authorized operators decide lifecycle actions.
4. After authoritative inputs exist, rerun read-only preflight and independent release verification against exact candidate, source snapshot and rollback bytes. Activation remains a separate host-managed operation and is not authorized by this dossier.

No production package was installed or activated; no host process was restarted or killed; no live plugin registry/config or workflow database was modified; no production dispatch, stage, commit, push, tag or publish was performed.

## Follow-up implementation delta (2026-10-27)

The Plan Graph projection boundary now validates caller-owned graph, candidate, search-options, and projection-options values as inert JSON before normal property reads. It rejects accessor-backed fields, non-enumerable properties, sparse/decorated arrays, symbol/prototype keys, non-finite values, cycles, and repeated object identities. The regression uses getter counters to verify candidate/graph accessors are rejected without invoking those getters. This closes a local input-boundary gap; it does not authenticate an upstream signature, trust configuration, or production authority.

Focused validation after this change: `node --test tests/test-adaptive-goal-graph.js tests/test-adaptive-goal-execution-graph-proposal.js tests/test-adaptive-goal-current-scope-producer-e2e.mjs` passed 41 tests, including the hostile-accessor case and isolated nine-producer three-graph E2E. The initial focused run exposed a backward-compatibility issue for omitted optional search options; the implementation was corrected to validate that argument only when provided, then the focused suite passed.

Because the Plan Graph source and its regression test changed, v48's source pins correctly became stale. Rather than rewrite v48, a successor `recovery-verifier-v49.json` was created, retaining the same graph, task and scoring oracle and refreshing 64 reviewed source pins. The v49 runner now defaults to v49 and still recognizes v47/v48 schema identities for historical analysis, but those historical fixtures fail closed when run against source bytes that no longer match their pins. v48 remains unchanged at SHA-256 `43408b90ca7cb083bd90e00cdd34ec163ed6fa3e292b4a17739d999995e89065`; v49 SHA-256 is `70f56ab4c0da6e5ea9acc0abc7527212d113f196206f60c0b9ebc92632f3ddcd`. Offline benchmark output `/tmp/runalith-agg-benchmark-v49-turn-20261027.json` SHA-256 `ba7952cc356a13f5e215dd563af871fe5683aea2deaec2526c00a05b5ca72aa6` contains 50 records, 5 summaries, 64 provenance records, and zero network/model calls. Benchmark regression suite passed 15/15.

### Candidate reinspection in this round

The preserved archives were found and structurally inspected; no candidate bytes were changed:

| Candidate | SHA-256 | Entries | Local extracted-runtime MCP fast test | Current source alignment |
| --- | --- | ---: | --- | --- |
| RC.8 `dist/runalith-1.0.9-rc.8-candidate-20261026T081256Z.mcpb` | `e1f49add15aaac00fa6924abbf630e41da01e552cf4f1b72639d7eb4b77dd776` | 92 | PASS | FAIL at historical README byte drift |
| RC.15 `dist/runalith-1.0.9-rc.15-candidate-20261027T1635.mcpb` | `f11e0303c0929f6d145f53f2033ce8195c2da6e9061bde1372ce6d19706091d1` | 93 | PASS | FAIL at current manifest byte drift |
| RC.16 `dist/runalith-1.0.9-rc.16-candidate-20261027T1700.mcpb` | `e28d9c46056bb315a11fb9022a46ab7af43def3b47747a649b71205e1e11d9bc` | 93 | PASS | FAIL after this follow-up source edit at `src/runtime/adaptive-goal-plan-adapter.js` |

All three pass `unzip -t`; `scripts/runalith-rollout.mjs` structural inspection confirms versions, entry points and 74/74 manifest/runtime tool parity. Their isolated MCP fast tests pass, but these are not production attestations. These checks do not clear the frozen 71-path contract: RC.8 has 92 archive entries and RC.15/RC.16 have 93, while the checked-in contract supplies only an expected count, not an authoritative signed path list. No path list was inferred and no archive was trimmed. The source tree is dirty and no authenticated builder receipt exists; therefore no successor release candidate or final evidence index was created after the additional Plan Graph source change.

### Current read-only live observation

`node scripts/reconcile-active-workflows.mjs --limit 200 --out /tmp/runalith-live-reconciliation-turn-20261027.json` completed read-only with 85 matching jobs, 60 stale-candidate reconciliation candidates, and 60 jobs with running tasks but no active lease. Host preflight observed installed RC.11, a readable SQLite database with integrity `ok`, 60 `EXECUTING` jobs, 61 running tasks, and zero active lease rows. These are inventory facts only; no lease absence or age observation proves a worker is dead. Every affected record remains on hold until owner/provider/runtime evidence confirms identity, attempt, event/result/artifact lineage, current lease/runtime state, and an owner-authorized lifecycle decision. No live database writes, task resets, retries, terminalization, or redispatch were performed.

### Remaining release blockers and responsible authority

- `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — controlled builder and independent release authority must supply authenticated builder provenance for exact candidate bytes/source snapshot, independent verifier predicate, candidate-bound test/inventory evidence, and separately authorized approval with a host-issued single-use nonce.
- `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — platform/security administrator must provision versioned verifier and reviewer trust JSON through an independently governed host mechanism, prove distinct provider identities/disjoint roots, attest the active runtime's effective configuration, and provide key custody/rotation/revocation records. The local config validator is not provisioning evidence.
- `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — platform/security operator must provide an authenticated host-owned checkpoint adapter and independently protected monotonic store, including signed nonce response, high-water sequence/previous digest, trust-domain and ledger digests, freshness, candidate and rollback bindings.
- `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` and `RUNNING_TASKS_MUST_DRAIN` — each workflow/task owner and provider/runtime operator must reconcile the exact 60 jobs/61 tasks individually and provide authoritative runtime/lease/attempt/result/artifact/completion evidence before an approved transition.
- `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2/artifact authority must supply the authoritative signed 71-path manifest, canonical source commit/tree/snapshot and authenticated builder receipt, or approve a separately reviewed contract change. A count is not a manifest.

The local release-evidence verifier, trust-config pair checks, hosted workflow sources and graph integration are testable implementations. They cannot create host administrator authority, a production key, an external checkpoint service, a builder attestation, or an independent release decision. Rollout remains **BLOCKED**.

### Final validation delta for the v49 worktree

- `npm test`: PASS, exit 0 after the v49 fixture and projection regression changes; includes trust/release-contract, Goal/Idea verifier, graph/proposal, nine-producer three-graph E2E, reviewer identity, evidence lineage, execution-plan binding, reconciliation, benchmark regression 15/15, rollout tests and telemetry.
- Focused graph/E2E suite: PASS 41/41. `npm run test:phase2-custody`: PASS 5/5. `npm run docs:check`: PASS, 98 Markdown files / 331 local links. `npm run site:check`: PASS, 74 tools. `git diff --check`: PASS.
- All three preserved RC.8/RC.15/RC.16 candidates pass ZIP integrity, structural inspection and isolated MCP fast test (74 manifest/runtime tools each). Current source alignment remains FAIL for RC.8 at `README.md`, RC.15 at `manifest.json`, and RC.16 at the changed Plan Graph adapter. The RC.16 post-change alignment command exits 1 with the source/archive hashes recorded above.
- `npm run test:phase2-security-regressions` was run and stops at `test-create-phase2-candidate-inventory.mjs`: no preserved candidate has exact current-source lineage after the Plan Graph source change. This is intentionally retained as an acceptance blocker; changing the test to accept a stale candidate or rebuilding a release candidate without the missing independent prerequisites would be unsafe. The remaining security regressions after that gate were run separately and passed.
- Final read-only preflight: exit 3, `BLOCKED`, `canActivateNow=false`, `liveMutationPerformed=false`; report `/tmp/runalith-preflight-rc16-final-turn-20261027.stdout.json`, SHA-256 `9b25b29186e6a1bb09f106c1093d85ed2d2459b3ac84a0e9a2a4f76ef809808a`. It observes installed RC.11, 60 executing jobs, 61 running tasks, zero active leases, missing effective trust configuration and no external anchor.
- Read-only reconciliation report: `/tmp/runalith-live-reconciliation-turn-20261027.json`, SHA-256 `2a6a7bc974f895bd8a66fdbd166379a8312003577f5a58aac90d8d01fb2a0b8b`; 85 matching jobs, 60 reconciliation candidates, 60 jobs with running tasks but no active lease. No lifecycle mutation was authorized or performed.

The acceptance inventory suite's source-lineage failure is the reason the current dirty source is not represented as a new MCPB candidate. No final evidence index was emitted, because local validation is not authenticated builder, independent release, host trust, or external checkpoint evidence.

## Additional trust-boundary and operator-evidence hardening (2026-10-27)

### Direct DSSE library callers

Reinspection found that `verifyRunalithDsseEnvelope()` was public and accepted in-memory envelope objects, but unlike policy and checkpoint validation it used `Object.keys`/field reads before canonicalizing that object. A caller could therefore provide an accessor-backed envelope and execute a getter during validation. The verifier now canonicalizes via property descriptors and reparses a strict inert JSON copy before inspecting envelope fields. Regression coverage proves an accessor is rejected without execution and a non-enumerable hidden property is not silently ignored. The CLI's raw-file path remains unchanged and still verifies signatures over the exact raw payload bytes.

### Rollout report publication and option validation

The operator invocation used in the previous preflight observation supplied `--out`, but preflight did not support an output-file option and the generic parser silently accepted unused options. This could lead an operator to believe a durable report had been written when it had only been printed to stdout. The rollout CLI now has per-command option allowlists and rejects unsupported flags. Preflight accepts `--report <new-path>` and atomically publishes a mode-0600 JSON report using an exclusive hard-link publication; it rejects symlinked/non-canonical parents and existing destinations. Its concise stdout summary returns the report path, digest, size, decision and blockers. `tests/test-runalith-rollout.mjs` now covers exclusive publication, symlinked-parent rejection, digest correctness and rejection of the old unsupported `--out` flag.

The safe operator procedure in `docs/adaptive-goal-graph-reconciliation.md` now gives both whole-set and single-job read-only commands and specifies owner/provider/runtime checks, dry-run, fencing, idempotency, audit capture and post-action reconciliation. The trust runbook documents `--report` and its failure behavior.

### Current exact preflight evidence

The corrected read-only preflight was run against preserved RC.16 and the exact local RC.11 rollback archive. Exit code `3` is the expected blocked result. The complete JSON report is `/tmp/runalith-preflight-report-final-20261027.json`, SHA-256 `05ad74409bab8a6ef53284fd683d9550848926ae8ff1c430fa343787e4bb5f4a`, size 547,139 bytes. The stdout summary is `/tmp/runalith-preflight-report-final-20261027.stdout.json`, SHA-256 `85deecbfa5aa4261943f7bcca08bb12f3ab12bf93d3e64ff40188b36ecb181ef`. It records `canActivateNow=false`, `liveMutationPerformed=false`, candidate RC.16 digest `e28d9c46056bb315a11fb9022a46ab7af43def3b47747a649b71205e1e11d9bc`, rollback digest `ad32acca11708314a45e82616b5d31c2fda7ae3710ff2f5c764f8fb12b1163c3`, installed RC.11, 60 executing jobs, 61 running tasks, zero active leases, missing effective trust configuration and `NOT_CONFIGURED` external anchor. Blockers remain independent release evidence, production trust configuration, external anchor, executing workflow drain and running task drain.

### Current source and validation boundaries

Repository HEAD remains `3becc361c411e1c04f5c41ea8c153ba4a3360dd2` with a dirty worktree; staged bytes remain zero. The new DSSE input-boundary source SHA-256 is `c4ffee253c5b01743997406bcd52f6da0aca66c616473f9ea6e278ea1f52c165`; its regression test SHA-256 is `5b5643af60d9fa263bd4d53851281935b397477a71f8e19052d46dd36997368a`. After the rollout CLI source change correctly triggered v49's provenance guard, v49 was preserved byte-for-byte and successor fixture v50 was created. Final v50 SHA-256 is `0a41a9c727a88faee3ff540e1d66a656e0276b4f7238fd0fa63b0c34269e24a1`, with 64 source pins and zero drift; it preserves v49's oracle and task graph and does not claim independent release authority. Offline benchmark output `/tmp/runalith-agg-benchmark-v50-turn-20261027.json` SHA-256 `7723e2318cc3a6df68bc96130a99fb7e8b9cd64567a69361767e80955933d3ec` contains 50 records, 5 summaries, 64 provenance records and zero network/model calls. v47/v48/v49 and all RC.8/RC.15/RC.16 candidate bytes remain unchanged.

The acceptance command `npm run test:phase2-security-regressions` was rerun and exits `1` at `test-create-phase2-candidate-inventory.mjs`, before later security subtests, because every preserved candidate fails exact current-source lineage. Its captured log is `/tmp/runalith-phase2-security-regressions-current-20261027.log`, SHA-256 `94ae8ac24efee382df383fc65470e937605d85d9343ffbe5e78113e185042489`. The forensic diagnostics confirm RC.16 first mismatches `src/runtime/adaptive-goal-plan-adapter.js`, RC.15 `manifest.json`, RC.8 `README.md`; the frozen contract remains `frozen-entry-count-only`, expected count 71, with no authoritative path list. The later security tests were executed separately and passed. This gate remains open; no candidate or final evidence index was created.

The first full `npm test` after rollout CLI hardening correctly exposed nine cascading benchmark failures because v49 pinned the pre-hardening `scripts/runalith-rollout.mjs` bytes. The runner's provenance check was not weakened. v50 now pins the reviewed CLI and regression-test bytes, and the isolated benchmark suite passes 15/15. The subsequent full `npm test` completed with **exit 0** after v50 was made the default; it included the trust/release-contract, Goal/Idea verifier, graph/proposal, nine-producer three-graph E2E, reviewer identity, evidence lineage, execution-plan binding, reconciliation, benchmark (15/15), rollout CLI (10/10), plugin E2E and telemetry suites. `node --test tests/test-runalith-rollout.mjs` independently passed 10/10 after the new exclusive report-publication and unknown-option regressions were added. `npm run docs:check`, `npm run site:check` and `git diff --check` also passed after the operational-documentation changes.

The final current-source alignment logs are `/tmp/runalith-source-alignment-rc8-current-20261027.log` (exit 1, SHA-256 `bc74b6078aaafdf67a5ef6f3809769e3e387bf4c0c3dcae6ae28b389d2982a78`), `/tmp/runalith-source-alignment-rc15-current-20261027.log` (exit 1, SHA-256 `f5ab9e2168179577205e021c5a0af2380057dd1bc287f1591e0c3bbfad9f22c0`) and `/tmp/runalith-source-alignment-rc16-current-20261027.log` (exit 1, SHA-256 `12ea1fa9722dab01b9bccd6f0b7e7079d851c96ebee9d4701032abc31d60a29b`). The current Phase 2 security gate was rerun and exits 1 at the expected candidate-inventory lineage gate; log `/tmp/runalith-phase2-security-regressions-final-20261027.log`, SHA-256 `6db171301fc6d8a3903361ad1da67be460bbec075f9dc33cb97db9bc06f51418`. All three preserved candidates still pass ZIP integrity and isolated MCP fast tests, but that is not source alignment, a signed builder receipt, or release authority. Rollout remains **BLOCKED**.
