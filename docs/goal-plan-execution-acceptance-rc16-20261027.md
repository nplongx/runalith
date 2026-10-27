# Runalith 1.0.9-rc.16 — integrated Goal/Plan/Execution Graph acceptance

Date: 2026-10-27. This is local acceptance evidence only; it is not a signed release attestation, production approval, or host authorization.

## Successor candidate identity

- Candidate: `dist/runalith-1.0.9-rc.16-candidate-20261027T1700.mcpb`
- Version / entry point: `1.0.9-rc.16` / `server/index-v1.0.9-rc.16.js`
- SHA-256: `e28d9c46056bb315a11fb9022a46ab7af43def3b47747a649b71205e1e11d9bc`
- Size: 838,565 bytes; ZIP entries: 93; manifest/runtime tools: 74/74
- Final source alignment report: `/tmp/runalith-alignment-rc16-final5-20261027.json` (the authoritative report digest is recorded in the consolidated evidence index)
- Final source snapshot SHA-256: `3ca6356869949b6001a541aa46a4ddc5f280a4f6600de4557a8598c935a0b30c`
- Packaging log: `/tmp/runalith-pack-rc16-20261027.log`
- Archive integrity log: `/tmp/runalith-zip-integrity-rc16-20261027.log`
- Isolated candidate smoke: `/tmp/runalith-mcpb-smoke-rc16-20261027.log`
- Final rollout preflight: `/tmp/runalith-preflight-rc16-final3-20261027.json` (SHA-256 `8c0bf0fd17cca1722269fd269adc6386232d32e7bfd03744f23658a9b1de2a15`; exit 3, read-only, `canActivateNow=false`)

RC.16 is a new candidate; RC.15 remains byte-for-byte preserved at `dist/runalith-1.0.9-rc.15-candidate-20261027T1635.mcpb` with SHA-256 `f11e0303c0929f6d145f53f2033ce8195c2da6e9061bde1372ce6d19706091d1`. RC.16 byte-aligns to the current source snapshot, but the worktree is dirty and no authenticated builder receipt was supplied. The alignment result therefore explicitly reports `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT`; it is not authenticated build provenance and does not establish release eligibility.

The packaging log's inline alignment used the then-current acceptance-input list and reported source snapshot `598ff9bebb6b6510885f166c36b9ce407764f8f23d7783a98657bb17dfedc4dd`. After adding the Phase 2 inventory producer/diagnostic, frozen-count regression and Execution Graph regression test to `BUILD_INPUT_PATHS`, the independent post-build recheck reported the final snapshot `3ca6356869949b6001a541aa46a4ddc5f280a4f6600de4557a8598c935a0b30c` with the same exact candidate digest and all 93 archive entries byte-aligned. This is a more complete current-source alignment result, not a claim that the older inline report used those inputs and not a substitute for authenticated builder provenance.

## Material implementation changes

1. `verifyAdaptiveGoalExecutionGraphProposalHash()` now rejects duplicate dependency references and independently checks the serialized Execution Graph is acyclic. This closes a gap where a caller could re-hash mutually consistent dependency and edge arrays containing a multi-node cycle.
2. Source-to-bundle snapshot inputs now include the Phase 2 custody evidence contract, CLI verifier and its regression tests. A drift regression proves that changes to this release-critical acceptance logic alter the source snapshot digest.
3. The release evidence verifier now validates the SLSA `resolvedDependencies` inventory as a bounded, unambiguous list: exactly one source repository/commit material, no duplicate URIs, and a valid SHA-256 digest for each non-source material.
4. Added negative regressions for re-hashed Execution Graph cycles/duplicate dependencies, ambiguous/missing-digest provenance materials, and Phase 2 custody-input drift.
5. Benchmark fixture v47 is the active successor with refreshed source pins; v46 remains immutable with SHA-256 `af1197fa544a0a1012785409abb39a1dc0b2e2d708d67f6046e652aee5a88eae`.

## Verified package facts

- Package/manifest version and entry point agree on `1.0.9-rc.16` and `server/index-v1.0.9-rc.16.js`.
- Source-to-bundle byte alignment: PASS for all 93 entries (92 exact source-byte matches plus one projected package-metadata entry).
- ZIP integrity: PASS; no compressed-data errors.
- Extracted candidate smoke: PASS; MCP initialize and `tools/list` returned all 74 declared tools.
- The Phase 2 frozen contract remains exactly 71 paths. The RC.16 candidate has 93 entries and remains blocked by that mismatch. No path list was inferred from the count, and no package was trimmed to force acceptance.

## Live, read-only reconciliation observation

Fresh read-only diagnostics were written to:

- `/tmp/runalith-reconcile-live-rc15-review-20261027.json`
- `/tmp/runalith-reconcile-v2-live-rc15-review-20261027.json`
- Per-record read-only audit: `/tmp/runalith-live-reconciliation-audit-rc16-20261027.json` (SHA-256 `af3c78d13141b0bae565bb2f40e63700af623b09879d571c50eac4be18d3a195`, 60 job records and 61 running-task records).

Both reports observed 85 matching jobs: 60 classified for stale-candidate reconciliation, 61 running tasks and zero `task_leases`. This is not proof that any worker is dead. The Goal/Idea overlay found two goals without stored verifier attestations and four planner source-evidence findings (`PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID`). The reports are diagnostic observations only: they do not cryptographically authenticate provider identity, host process identity, or owner authority, and do not authorize lifecycle mutation.

The per-record audit links the local event/attempt/result/artifact references for every observed `EXECUTING` job and running task. All 61 running tasks lack persisted process PID, session ID, provider run ID and provider session key; none has a task-linked result or artifact record in the available local report, and there are no active lease rows. Event lineage exists locally for all 61 tasks, but this is not authoritative provider/runtime proof. Each record is explicitly marked `HOLD_NO_AUTOMATIC_ACTION_AUTHORIZED` pending owner/provider/runtime confirmation.

Do not bulk-reset, retry, redispatch, or terminalize these records. For each job/task, an authorized owner/provider/runtime operator must supply the exact owner identity, provider run/session ID, runtime process identity, lease/heartbeat or provider status, and correlated event/attempt/result/artifact/completion hashes. Conflicting or missing evidence remains `HOLD`.

## Validation and release gate

Final local validation:

- `npm test`: PASS, exit 0; `/tmp/runalith-integrated-rc16-npm-test-final3-20261027.log` (SHA-256 `81c9a48940a356c2c5cf89640ed3e9220824daab2699594bb3b203d0a944313e`).
- Focused graph/provenance/alignment regressions: PASS 38/38; `/tmp/runalith-integrated-rc16-final-acceptance-focus-20261027.log` (SHA-256 `c4c9fdee5614f6fd7e8c72f20ca402a8972658fa6712eb0d58799f624122f2bc`).
- `npm run test:phase2-security-regressions`: PASS as a diagnostic suite; it explicitly retains `frozen_inventory_count_mismatch` for 93 vs 71 entries; `/tmp/runalith-integrated-rc16-phase2-security-final3-20261027.log` (SHA-256 `b8aa615741f10c273de2dedffe673ad5b40727587f86c4c2577d3334b53cb075`).
- `npm run test:phase2-custody`: PASS 5/5, including changed-candidate receipt substitution, authority/builder root collision and frozen-count rejection; `/tmp/runalith-integrated-rc16-phase2-custody-final3-20261027.log` (SHA-256 `d60f0bf36d4bac9c9599a8b6827d6d39a2081c2d73d9aa26f246c8d6fdb332f0`).
- `npm run docs:check`: PASS, 97 Markdown files and 331 local links; `/tmp/runalith-integrated-rc16-docs-check-final4-20261027.log` (SHA-256 `f636e40e8abf7894addbb32e095e6d0fbe90b2493748638b42706b1fc93df794`).
- `npm run site:check`: PASS, version `1.0.9-rc.16`, 74 tools, 12 local and 19 external links checked; `/tmp/runalith-integrated-rc16-site-check-final4-20261027.log` (SHA-256 `31e655414f2bdbfefbbdb74662e31343f6e36395f5266cb5005f7f9c096b8a89`).
- `git diff --check`: PASS; `/tmp/runalith-integrated-rc16-diff-check-final3-20261027.log` (empty output, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
- MCP candidate smoke: PASS 74/74 tools; `/tmp/runalith-mcpb-smoke-rc16-20261027.log` (SHA-256 `93390f75f0b8d9d1e67b74dcdc87d5565742e0dc6a72dd9868d38d19cdeeff48`).
- ZIP integrity: PASS; `/tmp/runalith-zip-integrity-rc16-20261027.log` (SHA-256 `9bca0bb0e23bfcabe2cb9d207c87bdea5d133796fc90ebf498b53fd47e7cfe52`).
- Active benchmark fixture v47: PASS 15/15; fixture SHA-256 `8764d590818b43a0c18758cff8a5b0b12f844268b5379671de3dae577eddd3d2`; its 64 source pins were rechecked with zero drift. Historical v46 remains unchanged.
- Rollout preflight: BLOCKED, exit 3, read-only; `/tmp/runalith-preflight-rc16-final3-20261027.json` (SHA-256 `8c0bf0fd17cca1722269fd269adc6386232d32e7bfd03744f23658a9b1de2a15`).
- Consolidated unsigned evidence index: `/tmp/runalith-integrated-evidence-manifest-v47-rc16-final3-20261027.json` (the index itself records its artifact hashes; it is not signed authority).

The final source snapshot explicitly binds the Phase 2 inventory producer/diagnostic, frozen-count regression test, custody contract/verifier/tests and serialized Execution Graph proposal regression test. Re-run validation after any further source or fixture changes; each result applies only to the exact bytes it evaluated.

**Release status: BLOCKED.** RC.16 is review/test evidence only. Source alignment, local signatures in fixtures, successful tests and local preflight do not create production authority.

Remaining mandatory blockers and owners:

1. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — controlled builder, independent verifier and release authority:** provide signed builder provenance for the exact RC.16 digest/source snapshot, independently signed verification predicate with candidate-bound tests/inventory, separately authorized release approval, and host-issued single-use nonce bound to candidate, source snapshot, installed baseline and rollback bytes. No such authenticated evidence was supplied.
2. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — platform/security administrator:** provision the versioned verifier and reviewer JSON trust configs through an independently governed mechanism; demonstrate distinct provider identities, disjoint roots, key rotation/revocation, and host-owned effective-config attestation. Local JSON files or candidate code cannot authenticate provisioning.
3. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — platform/security operator:** provide host-owned checkpoint adapter identity and independently protected monotonic-store attestation. Verify nonce, sequence continuity, previous digest, ledger/trust-domain digest, freshness and anti-rollback state outside the candidate/workflow database.
4. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` and `RUNNING_TASKS_MUST_DRAIN` — workflow/task owners plus provider/runtime operator:** reconcile every active/executing job and running task from authoritative provider/runtime/lease systems. Confirm durable event/attempt/result/artifact lineage and owner-approved outcome before any state transition. Missing lease rows or stale timestamps are not authorization.
5. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2/artifact authority:** provide the authoritative signed 71-path manifest, canonical source commit/tree/snapshot and authenticated builder receipt. The current checked-in contract freezes count only; the exact path list cannot be inferred. Preserve historical archive hashes and keep RC.16 blocked until a separately reviewed contract change or exact conforming artifact is provided.

No production package install/activation, live plugin registry/config mutation, host restart/kill, live workflow DB write, production dispatch, staging, commit, push, tag or publication was performed.

## Post-acceptance source-drift addendum (2026-10-27)

The original RC.16 source-alignment PASS above was observed before a subsequent reviewed source change in `src/runtime/adaptive-goal-plan-adapter.js`. After adding strict inert-JSON validation before Plan Graph projection reads caller-owned graph/candidate/options, the current RC.16 archive fails source alignment at that file: source SHA-256 `1e0edfaebc139f9aeeaa11bef68ab09d626ac71b9aef2d32e1d32ad0dabf4dca`, archived SHA-256 `79ee60654a624d5724627c456cb36a9a81297f6f6256b803ecc12f258de1aba5`. The preserved archive hash remains `e28d9c46056bb315a11fb9022a46ab7af43def3b47747a649b71205e1e11d9bc`; it was not rebuilt or modified.

The Plan Graph regression and integrated three-graph E2E pass locally, but they do not make the existing RC.16 bundle current-source aligned. The current acceptance test `npm run test:phase2-security-regressions` therefore stops at the candidate-inventory lineage gate because no preserved candidate matches the new source bytes; this is a valid acceptance blocker, not grounds to relax the test or alter the frozen inventory contract. A successor release candidate remains deferred until an independently controlled build/source snapshot and the required release-authority prerequisites are available. RC.8 and RC.15 remain preserved with their previously recorded historical alignment failures. Release remains **BLOCKED**.

## Integrated canonical-trust hardening addendum v57 (2026-10-27)

This addendum is the current local validation record. Historical RC.8/RC.15/RC.16 archive hashes and earlier observations above remain historical evidence and have not been rewritten to imply that the old archives contain the v57 source.

### Current candidate and source identity

- Current-source local-test-only candidate: `/tmp/runalith-1.0.9-rc.16-local-test-only-integrated-v57-20261027.mcpb`.
- Version / entry point: `1.0.9-rc.16` / `server/index-v1.0.9-rc.16.js`.
- Archive SHA-256: `074c4c80fffc44ba8dcd969649f25fd2d91ed4b08e063aa802490519cdb48a1d`; bytes: 840,908; entries: 93; tools: 74/74.
- Source-alignment report: `/tmp/runalith-source-alignment-v57-final-20261027.json`, SHA-256 `681fb319296b90f3a863e42cfc457f142997a34b211e31180bbe1d3f6ea9eb94`.
- `source_snapshot_sha256`: `be8545261ca9a22b100aa336c46fd24836fe01b34b90a4b2a57f56d0a9386568`.
- Alignment predicate: `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`; 92 archive entries match source bytes exactly and one `package.json` entry matches the documented metadata projection. ZIP integrity is PASS.
- The report still says `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT` and `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`. Byte alignment/reproducibility do not mean a clean or authenticated build.
- This candidate uses the current RC.16 runtime identity; it is not a rebuilt RC.8 archive and is not production-authorized. Historical RC.8/RC.15/RC.16 `dist/` archives remain untouched.

### Integrated implementation changes

1. Source-to-bundle build inputs now pin the Goal/Idea snapshot verifier, Plan Graph projection/compatibility, Execution Graph proposal/readiness/immutable-plan binding, reviewed typed inputs, reviewer identity, evidence lineage, sandbox executor and graph-chain E2E/negative regressions. The external checkpoint response contract, local CAS adapter implementation and adversarial tests are also pinned. Release-critical graph/anti-rollback code can no longer drift outside source snapshot identity.
2. Phase 2 host custody policy now requires versioned administration metadata, fixed repository/source commit/tree pins, distinct Ed25519 authority/builder key IDs, SPKI pins and explicit validity/revocation windows. Unknown fields, noncanonical timestamps, stale/expired/revoked roots, mismatched pins and root collision fail closed. Real manifest and builder receipt are still mandatory.
3. Added a host-owned external checkpoint bridge, invoked only with `--advance-external-checkpoint`. Default preflight never invokes it. It requires `/etc/runalith/external-checkpoint-trust.json`, the root-owned/hash-pinned `/usr/local/libexec/runalith/external-checkpoint-adapter`, distinct checkpoint/store-attestation roots, a fresh signed store attestation, signed continuity/checkpoint and an authority-signed post-CAS receipt. Ambiguous post-commit outcomes are recorded as `UNKNOWN_AFTER_COMMIT_ATTEMPT`; no automatic retry is made. No policy/adapter is provisioned here and no live transition was requested.
4. Preflight now explicitly distinguishes the default read-only path from an opt-in external security-store transition. Host-policy regression tests cover key collision, validity/revocation, unsafe endpoint, adapter-path substitution and caller-authored anchor claims.
5. Updated release-trust and production-trust runbooks with the host policy schemas, adapter protocol, owner/admin dependencies, permissions and safe handling of ambiguous commit outcomes.
6. Benchmark history is preserved through v57: active fixture v57 SHA-256 `c70cb2127cdda0b9e0c4e24e19e8be45f2fdd8480e7ad78a2eeadfc77ff6eca3`; predecessor v56 SHA-256 `0683058ad3cf65d604738b8bda0f1b933731540c8a73cea31eaab229e1a69833`. Historical v52–v56 hashes are unchanged and asserted by tests.

### Validation evidence for v57

- `npm test`: PASS, exit 0; `/tmp/runalith-npm-test-integrated-v57-20261027.log`, SHA-256 `b43abb69fdab227cc980b52ef02c7fd6755f30f578dc8cd71317076105b62c0a`. Includes source alignment/evidence-pack, trust config/entrypoint, builder/verifier/custody, Goal/Idea verifier, Plan/Execution Graph, typed artifact lineage, reviewer identity, current-scope producer E2E, reconciliation, benchmark v57 (15/15), rollout (14/14), local MCP E2E and telemetry.
- Package reproducibility: PASS; `/tmp/runalith-package-reproducibility-v57-final-20261027.log`, SHA-256 `50129a58839de5c5606a37686652a83f3b30fa79f99b6040d789dd6bebe3b253`.
- MCP candidate fast test: `MCPB_FAST_TEST=PASS`, initialize + health + tool count 74/74 in an isolated DB; `/tmp/runalith-mcpb-fast-v57-final-20261027.log`, SHA-256 `1903b9e7da583505632f2b8f3f31f7057d931786bf3fa419e23481416c68c967`.
- `npm run docs:check`: PASS, 99 Markdown / 331 local links; `/tmp/runalith-docs-check-v57-final-20261027.log`, SHA-256 `6f0a0e6b3e00f5b03fd6add35e4e02f2a843cd90f8575f346d56d6f9f7284bc9`.
- `npm run site:check`: PASS, 74 tools; `/tmp/runalith-site-check-v57-final-20261027.log`, SHA-256 `31e655414f2bdbfefbbdb74662e31343f6e36395f5266cb5005f7f9c096b8a89`.
- ZIP integrity: PASS; `/tmp/runalith-zip-integrity-v57-final-20261027.log`, SHA-256 `6d29680bf7631893fee6d3fdfad67c193ec22f5198878aa8bc1bfc850cd37fcb`.
- `git diff --check`: PASS; `/tmp/runalith-diff-check-v57-final-20261027.log`, empty output SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Final read-only preflight: **BLOCKED**, exit 3, `canActivateNow=false`; `/tmp/runalith-preflight-v57-final-20261027.json`, SHA-256 `d452766280c293e2d9941c2e16e3b9164b22a110e6ab9ad6e1b03aa138f54fe2`. It records `readOnly=true`, `liveMutationPerformed=false`, and no host lifecycle, workflow DB or external-store mutation.

### Six blockers — all remain open

The final preflight returns the same six blockers. No blocker was closed via synthetic fixtures, locally minted keys, local SQLite or test-local dispatch.

1. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2 contract owner, controlled builder, platform-security administrator.** Missing `/etc/runalith/phase2-custody-trust.json`, real owner-signed canonical 71-path manifest, and builder-signed receipt bound to exact candidate/source commit/tree. Candidate inventory is 93 entries; do not trim it or guess the frozen list. Validate real signatures/bindings with `node scripts/verify-phase2-custody-evidence.mjs`, then rerun preflight.
2. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — controlled builder, independent verifier, release authority.** Missing `/etc/runalith/release-policy.json`, signed SLSA provenance for exact candidate/source snapshot, independent candidate-verification envelope, separately signed approval binding candidate/baseline/rollback, and host-issued one-time nonce. Local hash/reproducibility evidence is not release authority.
3. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — platform/security administrator.** Effective host runtime reports `AGG_TRUST_CONFIG_NOT_CONFIGURED`. Provision and independently validate the versioned verifier and reviewer JSON trust configs, disjoint roots/provider identities, rotation/revocation and host-owned effective-config provenance. Do not mint roots locally.
4. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — platform/security operator.** Effective anchor is `NOT_CONFIGURED`. Missing the external checkpoint policy, installed hash-pinned adapter, independently administered monotonic store, fresh store attestation under a distinct key, signed checkpoint/continuity and signed CAS receipt. The opt-in mutating path was not invoked; local SQLite tests are not production-anchor evidence.
5. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — each job owner and provider/runtime operator.** Final preflight sees 60 executing jobs, workflow DB integrity `ok`, and zero active lease rows. Zero leases does not prove a worker is dead. Resolve each job against authoritative owner/provider/runtime/heartbeat/process status and correlated event/attempt/result/artifact history; only an authorized owner may approve the normal lifecycle transition.
6. **`RUNNING_TASKS_MUST_DRAIN` — task owners and provider/runtime operator.** Final preflight sees 61 running tasks and zero active leases. Per-record audit `/tmp/runalith-live-reconciliation-audit-rc16-20261027.json` (SHA-256 `af3c78d13141b0bae565bb2f40e63700af623b09879d571c50eac4be18d3a195`) reports all 61 lack persisted PID, session ID, provider run ID/provider session key and task-linked result/artifact records in that report. Each needs owner/provider/runtime verification; preserve unresolved state and do not reset, terminalize, retry, cancel or redispatch based on this evidence alone.

### Safety and authority conclusion

The producer → nine-node Plan Graph DAG → Execution Graph proposal E2E passed in disposable state. Reviewer identity, immutable-plan binding and dispatch assertions apply only to that test-local trust/DB; sandbox evidence explicitly keeps `productionAuthorityGranted=false`. No production install/activation, live plugin registry/config change, process restart/kill, live workflow DB write, production dispatch or external checkpoint transition was performed. Repository HEAD remains `3becc361c411e1c04f5c41ea8c153ba4a3360dd2`, staged changes are zero, and the worktree remains dirty. **Release status remains `BLOCKED`.**

## Integrated canonical-trust hardening addendum v58 (2026-10-27)

This addendum records the final code state after pinning the release policy to the canonical production target. The v57 addendum and all older candidate observations remain historical; the report links below are the current V58 evidence.

### Exact local candidate and source snapshot

- Candidate: `/tmp/runalith-1.0.9-rc.16-local-test-only-integrated-v58-20261027.mcpb`.
- Package version / entry point: `1.0.9-rc.16` / `server/index-v1.0.9-rc.16.js`.
- SHA-256: `074c4c80fffc44ba8dcd969649f25fd2d91ed4b08e063aa802490519cdb48a1d`; 840,908 bytes, 93 archive entries, 74/74 tools.
- Source-alignment report: `/tmp/runalith-source-alignment-v58-final-20261027.json`, SHA-256 `f6d0781952762e28ef265db50d12cdc7264459f43c981f9b64a7dda618ba69cd`.
- `source_snapshot_sha256`: `b7bc2c212937f9863925e5ff73ed61623f493a570a3d82b926106e432415290a`.
- 92 archive entries match source bytes exactly and the one `package.json` entry matches the documented metadata projection; ZIP integrity passed.
- Source-alignment verdict is `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`, while source provenance remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT` and release eligibility remains `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`. This is a local-test-only candidate, not a clean/authenticated build or release approval.

### v58 hardening beyond v57

The rollout now has `validateHostPinnedReleasePolicyScope()` and checks the fixed-host release policy's scope **before opening caller-selectable DSSE evidence paths**: repository must be `https://github.com/nplongx/runalith`, subject must be `runalith.mcpb`, build type must be `https://runalith.dev/build/mcpb/v1`, target environment must be `production`, and policy version must be a positive integer. Negative tests cover repository/subject/build-type/environment substitutions and invalid version. This prevents a root-owned policy file from silently retargeting this CLI's canonical release scope. A root-owned file is still not proof of external admin change-control or key custody: the report labels the observation `rootOwnedHostFileVerified`, and independent administrator provisioning remains mandatory.

The benchmark successor is v58, SHA-256 `4e311b3d5b41e18c7524f662df4ce0353414e67bd1ae045908f6b8494b7f82fd`, superseding v57 `c70cb2127cdda0b9e0c4e24e19e8be45f2fdd8480e7ad78a2eeadfc77ff6eca3`. It refreshes source pins for the release-scope guard and its tests; v52–v57 remain byte-for-byte preserved. The source snapshot also pins the Goal/Idea → Plan → Execution Graph trust/lineage implementation and regression tests, the Phase 2 custodian verifier and the external checkpoint/CAS contract from prior addenda.

### Validation evidence for v58

- `npm test`: PASS, exit 0; `/tmp/runalith-npm-test-integrated-v58-20261027.log`, SHA-256 `95f27f3d4db58988cc0e62020dc65e561e44e2f03b0229c14d068d5be4896356`. It includes benchmark v58 (15/15), rollout (15/15), graph-chain producer E2E, trust configuration, release/Phase2 custody, reviewer/lineage, reconciliation, MCP workflow E2E and telemetry.
- Candidate source-alignment: PASS as described above; exact archive SHA remains `074c4c80...` but current source snapshot changed to `b7bc2c21...` because the new policy guard is part of release-critical build inputs.
- Package build/extracted-runtime validation: PASS; `/tmp/runalith-package-integrated-v58-20261027.log`, SHA-256 `4228c3d4aebb8cd6a4dc10b636f6556ef71322b1b9d4441f612110a742e870d1`. This covered runtime smoke, 74 tool schemas, lease fencing, stdio shutdown/backpressure, trust/reviewer configuration, read-only reconciliation, current-scope producers, nine-node Plan Graph, Execution Graph proposal and test-local action executor.
- `npm run test:mcpb-candidate -- <V58 candidate>`: `MCPB_FAST_TEST=PASS`, `/tmp/runalith-mcpb-fast-v58-final-20261027.log`, SHA-256 `cd931896bb063ee89e624ee5c19ca5cd3400b7cf6cf0c65c41a1a54fd25dbf77`; 74/74 tools, health `ok/local-only-mcp`, isolated DB.
- `npm run test:package-reproducibility`: PASS; `/tmp/runalith-package-reproducibility-v58-final-20261027.log`, SHA-256 `50129a58839de5c5606a37686652a83f3b30fa79f99b6040d789dd6bebe3b253`.
- ZIP integrity: PASS; `/tmp/runalith-zip-integrity-v58-final-20261027.log`, SHA-256 `10b8c85dc3f6d15c7543da943f56bfa8d9852699ddf1213668fcdb23a276277f`.
- `npm run docs:check`, `npm run site:check` and `git diff --check` must be rerun after this addendum; the final dossier check log paths are supplied in the v58 unsigned evidence index. No staged change was made.
- Final read-only preflight: **BLOCKED**, exit code `3`, report `/tmp/runalith-preflight-v58-final-20261027.json`, SHA-256 `aff3d7dba393dea62991b68d037bd4a0fbed8d45b5bf20ca91ea16c226f14aba`. The report states `canActivateNow=false`, `readOnly=true`, `liveMutationPerformed=false`, and no host-lifecycle, workflow DB or external security-store mutation. Candidate smoke passed and the RC.11 local rollback bundle verified with exact installed-file parity.
- Consolidated unsigned evidence index: `/tmp/runalith-integrated-evidence-index-v58-rc16-final2-20261027.json`. It records exact artifact paths/hashes and the six blockers as OPEN; it is an integrity index, not a signed release authorization.

### Six blockers after the final preflight — all OPEN

1. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` — Phase 2 contract owner + controlled builder + platform-security administrator.** Required: host policy `/etc/runalith/phase2-custody-trust.json`, the real owner-signed canonical 71-path manifest and builder-signed receipt bound to this candidate/source commit/tree. The candidate has 93 entries; no trimming or inferred path list is accepted.
2. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` — controlled builder + independent verifier + release authority.** Required: `/etc/runalith/release-policy.json` from the approved admin change process, signed SLSA provenance for exact candidate/source snapshot, independently signed candidate-verification evidence and test inventory, separate release-authority approval bound to candidate/baseline/rollback, and host-issued one-time nonce. Local reproducibility and hashes are not authority.
3. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` — platform/security administrator.** Effective host trust status remains `AGG_TRUST_CONFIG_NOT_CONFIGURED`. Required: two versioned, independently governed verifier and reviewer trust JSON configs, separate identities/disjoint roots, validated rotation/revocation and authenticated host effective configuration. Do not create production roots locally.
4. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` — platform/security operator.** Effective external anchor remains `NOT_CONFIGURED`. Required: `/etc/runalith/external-checkpoint-trust.json`, installed root-owned/hash-pinned adapter at `/usr/local/libexec/runalith/external-checkpoint-adapter`, independently administered monotonic store, fresh store attestation under a distinct key, signed checkpoint continuity and signed post-CAS commit receipt. The mutating `--advance-external-checkpoint` path was not invoked; local SQLite tests are not external evidence.
5. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` — each job owner + provider/runtime operator.** Preflight sees 60 executing jobs, DB integrity `ok`, zero active leases. Zero leases is not proof workers are gone. For each job, reconcile authoritative owner/provider/runtime/heartbeat/process state with event/attempt/result/artifact lineage and get the owner's approved normal lifecycle disposition. Do not bulk-reset stale jobs.
6. **`RUNNING_TASKS_MUST_DRAIN` — each task owner + provider/runtime operator.** Preflight sees 61 running tasks, zero active leases. The previously retained per-record audit `/tmp/runalith-live-reconciliation-audit-rc16-20261027.json` (SHA-256 `af3c78d13141b0bae565bb2f40e63700af623b09879d571c50eac4be18d3a195`) says all 61 lack persisted PID/session/provider-run/provider-session identity and task-linked results/artifacts in that report. Confirm every task with authoritative provider/runtime evidence and owner disposition. No reset, terminalization, retry, cancel or redispatch is authorized by local timestamps or missing leases alone.

The integrated producer → nine-node Plan Graph DAG → Execution Graph proposal passes only in disposable test state; test reports explicitly keep `productionAuthorityGranted=false`. No production package install/activation, host config/registry change, process restart/kill, live DB write, production dispatch or external checkpoint transition has occurred. Historical RC.8/RC.15/RC.16 archives remain immutable. HEAD remains `3becc361c411e1c04f5c41ea8c153ba4a3360dd2`, staged files zero, worktree dirty. **Release remains `BLOCKED`.**

## Integrated external-checkpoint continuity-binding addendum v59 (2026-10-27)

This is the latest source, benchmark and preflight record. It succeeds V58 without replacing or editing the historical v52–v58 fixture files or any `dist/` archive.

### Current local artifact

- Local-test-only candidate: `/tmp/runalith-1.0.9-rc.16-local-test-only-integrated-v59-20261027.mcpb`.
- Version / entry point: `1.0.9-rc.16` / `server/index-v1.0.9-rc.16.js`; 840,908 bytes, 93 archive entries, 74 tools.
- Candidate SHA-256: `074c4c80fffc44ba8dcd969649f25fd2d91ed4b08e063aa802490519cdb48a1d`.
- Source-alignment report: `/tmp/runalith-source-alignment-v59-final-20261027.json`, SHA-256 `d83ac909960303568e29385bb72e04868d1faf42db5ba89020a963ac04c64a58`.
- Source snapshot SHA-256: `0d4001447cf7a5a765073b8fe7e3c302d8b4ab07c307004a4b32190fafe874e2`. Alignment is `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT` (92 exact archive source bytes plus the one documented package metadata projection); ZIP integrity passed.
- The provenance decision remains `DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT` and release eligibility remains `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`. This is not a production release candidate authorized for installation.

### Security improvement beyond V58

The external-store attestation now binds its signed `evidence_sha256` to the canonical exact continuity tuple that the checkpoint verifier consumes: authority ID, external store ID, service URI, continuity source, high-water sequence and previous checkpoint digest. `verifyExternalStoreAttestation()` checks this binding in addition to the distinct store-attestation Ed25519 signature, validity window and root provisioning. Regression tests prove both a substituted continuity digest and a substituted evidence hash fail with `EXTERNAL_CHECKPOINT_STORE_ATTESTATION_BINDING_MISMATCH`, even when the test can create signatures using a disposable key. The runbook now states this contract. It does **not** prove a real external store or trusted key has been provisioned.

Benchmark fixture V59 is SHA-256 `15d751d1501b9944bc3c57f7e855d6994bcae79ca4d6506ea37cb5f8e963761e`, succeeding V58 `4e311b3d5b41e18c7524f662df4ce0353414e67bd1ae045908f6b8494b7f82fd`. V52–V58 are unchanged. Existing canonical release-policy scope constraints (fixed repository/package/build type/production environment) and the source snapshot closure for all three graph stages remain active.

### V59 validation results

- `npm test`: PASS, exit 0; `/tmp/runalith-npm-test-integrated-v59-20261027.log`, SHA-256 `e627a05ede1d6270ae440f20d8a0a29ad09a7fc1b1251f24d7d372a20ab97ac4`. Includes graph verifier/projection, typed artifact/lineage, reviewer, current-scope producer E2E, benchmark V59 (15/15), rollout suite (15/15), reconciliation, plugin and telemetry suites.
- Package build + extracted runtime integration: PASS; `/tmp/runalith-package-integrated-v59-20261027.log`, SHA-256 `67b2e10c3c41d54592514e3c7d48e0a0bf319bd902ab973db5a8e8f7dca050d5`.
- MCP fast test on exact V59 archive: `MCPB_FAST_TEST=PASS`, 74/74 tools and isolated temporary DB; `/tmp/runalith-mcpb-fast-v59-final-20261027.log`, SHA-256 `17098f79e1a1477e07bf1b4e3ddb7b1b8d787ccb744858da274de035959254b4`.
- Package reproducibility: PASS; `/tmp/runalith-package-reproducibility-v59-final-20261027.log`, SHA-256 `50129a58839de5c5606a37686652a83f3b30fa79f99b6040d789dd6bebe3b253`.
- ZIP integrity: PASS; `/tmp/runalith-zip-integrity-v59-final-20261027.log`, SHA-256 `f465442c2b14e9dcf593f91f88f45519ac402637060e2e2349352515123ffa7c`.
- The final dossier edition is followed by a fresh `npm run docs:check`, `npm run site:check` and `git diff --check`. Their logs are `/tmp/runalith-docs-check-v59-final-20261027.log`, `/tmp/runalith-site-check-v59-final-20261027.log` and `/tmp/runalith-diff-check-v59-final-20261027.log` respectively.
- Final read-only preflight: **BLOCKED**, exit code 3, `canActivateNow=false`; `/tmp/runalith-preflight-v59-final-20261027.json`, SHA-256 `5141c8d0ee3ec654e3768a0b8f1862fc573c3381ad53e2570aff8b785f85eb81`. It records `readOnly=true`, `liveMutationPerformed=false`, and no host lifecycle, workflow DB or external security-store mutation. Rollback `1.0.9-rc.11` matches the installed generation byte-for-byte.
- Fresh per-record workflow reconciliation: `/tmp/runalith-reconcile-v59-final-20261027.json`, SHA-256 `14cce9d6773496eee2ca7192399de2c51dcf710b56612ec1f004a051530af372`. It was explicitly read-only, considered 85 job records, classified 60 as stale candidates needing owner/runtime reconciliation, and retained `HOLD` actions; it does not authorize any lifecycle transition.
- Consolidated unsigned integrity index: `/tmp/runalith-integrated-evidence-index-v59-rc16-final2-20261027.json` (index path only; hash is reported separately to avoid a circular hash reference).

### Remaining six release blockers — OPEN

The final preflight retains all six blocker identifiers; no blocker has been closed by the local implementation/tests:

1. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`** — Phase 2 contract owner, controlled builder and platform-security administrator must provide `/etc/runalith/phase2-custody-trust.json`, the true owner-signed canonical 71-path manifest and builder-signed receipt bound to exact candidate/source commit/tree. Current candidate inventory is 93 entries; no trimming or inferred manifest is acceptable.
2. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`** — controlled builder, independent verifier, release authority and platform administrator must provide `/etc/runalith/release-policy.json` through the approved management process, signed SLSA provenance, independent candidate-verification/test evidence, separate signed release approval bound to candidate/baseline/rollback, and a host-issued one-time nonce.
3. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`** — platform/security administrator must provision independently governed, versioned verifier and reviewer trust JSON configurations with distinct identities/disjoint roots, rotation/revocation evidence, and authenticated effective host configuration. Host runtime currently reports `AGG_TRUST_CONFIG_NOT_CONFIGURED`.
4. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`** — platform/security operator must provision `/etc/runalith/external-checkpoint-trust.json`, the root-owned hash-pinned adapter, an independent monotonic store, the signed fresh continuity-bound store attestation and signed checkpoint/commit receipts. Effective anchor is `NOT_CONFIGURED`; no mutating opt-in transition was invoked.
5. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`** — each of the 60 executing-job owners plus provider/runtime operators must verify job state against authoritative worker/provider/heartbeat/process evidence, correlated event/attempt/result/artifact lineage and owner-approved lifecycle disposition. The current DB has integrity `ok` and zero active lease rows; zero leases does not prove a worker stopped.
6. **`RUNNING_TASKS_MUST_DRAIN`** — each of the 61 running-task owners plus provider/runtime operators must establish authoritative provider/session/process/lease identity, match task result/artifact/completion lineage, and approve a normal disposition. The fresh per-record report `/tmp/runalith-reconcile-v59-final-20261027.json` shows unresolved owner/provider/runtime identity for affected records, missing leases (explicitly not proof of worker death), and incomplete task dependency materialization in at least one detailed example; all records remain HOLD. The earlier per-record audit `/tmp/runalith-live-reconciliation-audit-rc16-20261027.json` is retained as historical evidence only. No bulk reset, terminalization, retry, cancel or redispatch is authorized.

The producer → nine-node Plan Graph DAG → Execution Graph proposal passes in disposable E2E state only. The sandbox result explicitly keeps `productionAuthorityGranted=false`. No production installation/activation, host registry/config mutation, process restart/kill, live workflow DB write, production dispatch or external checkpoint transition was performed. Historical RC.8/RC.15/RC.16 archives remain immutable; HEAD remains `3becc361c411e1c04f5c41ea8c153ba4a3360dd2`, staged files remain zero, and the pre-existing worktree is still dirty. **Release remains `BLOCKED`.**
