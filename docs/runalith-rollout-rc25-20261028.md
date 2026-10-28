# Runalith RC.25 rollout dossier — 2026-10-28

## Decision

**`BLOCKED`; do not activate, restart or dispatch production.** Candidate archive and source-to-bundle bytes verify, and tests pass. The preflight remains blocked on the six independent authority and workflow-drain conditions. No host registry/config, workflow DB, process lifecycle, or external checkpoint was mutated.

## Frozen candidate and rollback identity

- Candidate: `dist/runalith-1.0.9-rc.25-runtime-trust-ledger-and-evidence-integrity-20261028.mcpb`
- Candidate version: `1.0.9-rc.25`; SHA-256 `84d8ddf1fe3c55ad0d1e47a91e3fa11c7267209ffc48cc162f3e915ea03b017e`; size 854,080 bytes; 93 unique ZIP entries; 74 manifest and runtime tools.
- Runtime identity: package `main`, `runtimeEntryPoint`, `scripts.start`, MCP manifest `server.entry_point`, and MCP argument all select `server/index-v1.0.9-rc.25.js`. Entrypoint SHA-256 `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`.
- Source alignment: `PASS_EXACT_ARCHIVE_ENTRY_BYTES` / `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`; source snapshot SHA-256 `16db7a4667a7c6280260c8dd063debed8ea79d4ecdc2832cea29ec4f07e4564a`; report `/tmp/runalith-source-alignment-rc25-runtime-trust-ledger-and-evidence-integrity-20261028.json`, SHA-256 `d22c2a656d4e5c1e4056355f77d4fcc5146122f84583d9c926e97ca81601a9a4`.
- Installed baseline / rollback: RC.17, `dist/runalith-1.0.9-rc.17-final2-candidate-20261028.mcpb`, SHA-256 `3ca54ac58c397695bde770ef979315b5f996abf25c9628602fefa7e41c69bc64`; `rollback.verified=true`, smoke passed and installed-generation parity matched 93/93 files.
- Historical archives were not overwritten: RC.23 SHA-256 `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; RC.24 SHA-256 `125d785b897dee1b6758c8f6d3508c7930d2a87f357d1b953616e7043fb596c8`.

## Reproducible validation results

| Check | Result / record |
|---|---|
| `npm test` | Exit 0; log `/tmp/runalith-npm-test-rc25-integrated-trust-ledger-v67-20261028.log`; SHA-256 `8109de931ef1a3ad6ed143784462fd2ff2251eeb2d9c251085923a5daac6a92f` |
| `npm run pack:runalith-mcpb` | Exit 0; archive SHA-256 above; 74/74 schemas, extracted runtime smoke and extracted regression/E2E checks pass |
| `unzip -t dist/runalith-1.0.9-rc.25-runtime-trust-ledger-and-evidence-integrity-20261028.mcpb` | Exit 0; no compressed-data errors; 93/93 unique paths |
| `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.25-runtime-trust-ledger-and-evidence-integrity-20261028.mcpb` | Exit 0; `MCPB_FAST_TEST=PASS`; runtime `ok/local-only-mcp`; 74/74 tools |
| `npm run test:package-reproducibility` | Exit 0; `PASS` |
| `node --test tests/test-adaptive-goal-benchmark.mjs` | Exit 0; 15/15 tests. Versioned v67 successor tracks current source bytes; v66 stays unchanged. |
| `npm run docs:generate-reference` | Exit 0; generated 74-tool reference from RC.25 source |
| `npm run docs:check` | Exit 0; 115 Markdown files, 336 local links, reference parity 74/74 |
| `node scripts/build-static-site.mjs` | Exit 0; generated the RC.25 site from its checked-in template. |
| `npm run site:check` | Exit 0; RC.25 acceptance file and runtime entrypoint are in sync; 12 local links valid. |
| `node scripts/check-static-site.mjs --check-external-links` | Exit 0; 16/16 external URLs passed. |
| `npm run docs:check:external` | Exit 0; 117 Markdown files, 336 local links, 31/31 external URLs passed. |
| `git diff --check` | Exit 0 after final dossier and site-template edits. |

Archive hashes and a local source-alignment report prove byte identity only. The source-alignment report explicitly retains `releaseEligibility=BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`; neither the packager nor local tests create a builder receipt, independent verifier signature, release approval, trust root, Phase 2 contract, or external checkpoint proof.

## Effective preflight evidence

Run:

```sh
node scripts/runalith-rollout.mjs preflight \
  --candidate dist/runalith-1.0.9-rc.25-runtime-trust-ledger-and-evidence-integrity-20261028.mcpb \
  --rollback-bundle dist/runalith-1.0.9-rc.17-final2-candidate-20261028.mcpb \
  --report /tmp/runalith-preflight-rc25-runtime-trust-ledger-and-evidence-integrity-20261028-v2.json
```

Observed result: exit code **3** (blocked by policy), status `BLOCKED`, `canActivateNow=false`, `readOnly=true`, `liveMutationPerformed=false`, `externalSecurityStoreMutationPerformed=false`, checkpoint transition `NOT_REQUESTED`. Report SHA-256 `6db5158aac375ce3c068d4065c3ef02e7332405adf74aa2abc44f07c0a1e8437`, 552,230 bytes, mode `0600`.

The preflight observes the installed host plugin at RC.17, enabled/ready, with empty plugin `config`. It did not inspect an RC.25 effective runtime because RC.25 is not installed. It does not claim production trust is configured.

## Open gates and owner actions

1. **`PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED`** — Phase 2 contract owner must issue the exact canonical 71-path inventory with independent owner signature and builder receipt bound to this candidate/source snapshot. The package's 93 ZIP entries are a different inventory and cannot substitute for this contract.
2. **`INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`** — independent builder, verifier and release authority must supply signed candidate provenance, verification and approval bound to candidate, installed baseline/rollback bytes and host-issued nonce under `/etc/runalith/release-policy.json`. File hashes, tests and dossiers are insufficient.
3. **`PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`** — host/security administrator must provision both versioned JSON trust configurations through host-owned configuration, independently own the two trust roots/providers, configure validity/rotation/revocation and the separate append-only ledger, and verify effective values in the actual host runtime. A blank field or unexpanded placeholder is not effective configuration.
4. **`PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`** — security administrator must provision `/etc/runalith/external-checkpoint-trust.json`, a separately administered monotonic external store and trusted adapter; provide signed continuity/CAS receipts for the prior and proposed checkpoint. Do not request checkpoint advancement until the host authority signs off.
5. **`ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`** — workflow owners/providers must correlate every executing job with current events, attempts, results, artifacts, owner, provider, runtime and leases; use normal authorized lifecycle handling only. No bulk terminalization, reset or speculative recovery.
6. **`RUNNING_TASKS_MUST_DRAIN`** — account for all running tasks with owner/provider/runtime confirmation and current lineage. Missing leases alone do not prove workers are dead. Do not kill, reset, terminalize, drain or dispatch based on age alone.

Fresh read-only reconciliation: `/tmp/runalith-live-reconcile-rc25-sensitive-20261028.json`, generated `2026-10-28T06:01:26.529Z`, 7,234,927 bytes, mode `0600`, SHA-256 `22bdae48cfecbfd82d81d5beba2e2804ad9c9fb20f22d169fc2b9ffe4289d6fe`. Counts: 137 jobs, 1,277 tasks, 5,308 events, 908 results, 867 artifacts, 982 attempts, 119 approvals, zero lease rows. Current selection has 60 reconciliation candidates, 18 awaiting proposal/approval and 7 awaiting dispatch. It reports 61 running tasks associated with 60 jobs without active leases; they remain unresolved, not presumed dead.

Goal/Idea and Plan/Execution state remains ineligible: two Goal/Idea graphs have empty evidence manifests and zero attestations; 63 planner runs contain 373 evidence records but zero claim-verification records; four source-revalidation findings remain; three Plan Graph proposals have 22 unsupported steps and no authenticated current-snapshot binding; zero persisted Execution Graph proposals or execution-plan-candidate events exist. These are live findings, not authorization to repair persisted rows in place. Build new versioned, producer-bound artifacts and proposals, then independently verify them.

## Decision rule

Keep rollout `BLOCKED` until all six gates are resolved with evidence from the corresponding authority and a fresh read-only preflight reports no blockers. Then require approval to activate through the host plugin UI, verify exact installed-file parity and runtime identity, and query health via the host-connected MCP client. No command in this task activated RC.25, edited host registry/config, wrote the live workflow database, terminated a process or advanced an external checkpoint.
