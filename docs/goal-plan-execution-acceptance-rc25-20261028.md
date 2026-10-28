# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.25

**Decision: `BLOCKED` for production rollout.** Local integration and archive integrity checks pass. Production authority, the owner-signed Phase 2 71-path contract, an external monotonic checkpoint, and live workflow/task drain are not proven. This document records observed evidence; it does not grant approval or activation authority.

Machine-readable acceptance record: `docs/goal-plan-execution-acceptance-rc25-20261028.json`.

## Candidate identity

| Field | Verified value |
|---|---|
| Candidate | `dist/runalith-1.0.9-rc.25-runtime-trust-ledger-and-evidence-integrity-20261028.mcpb` |
| Version | `1.0.9-rc.25` |
| Archive SHA-256 | `84d8ddf1fe3c55ad0d1e47a91e3fa11c7267209ffc48cc162f3e915ea03b017e` |
| Archive size | 854,080 bytes |
| ZIP entries / unique paths | 93 / 93 |
| Manifest tools / runtime tools | 74 / 74; unique manifest tool names 74 |
| Runtime entrypoint | `server/index-v1.0.9-rc.25.js` |
| Entrypoint SHA-256 | `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1` |
| Package / manifest / `npm start` | All identify `1.0.9-rc.25` and the same versioned entrypoint |
| Source snapshot SHA-256 | `16db7a4667a7c6280260c8dd063debed8ea79d4ecdc2832cea29ec4f07e4564a` |
| Source-alignment report | `/tmp/runalith-source-alignment-rc25-runtime-trust-ledger-and-evidence-integrity-20261028.json`, SHA-256 `d22c2a656d4e5c1e4056355f77d4fcc5146122f84583d9c926e97ca81601a9a4` |

The archive itself passed `unzip -t`. The packager validated the extracted MCP runtime and all 74 tools/schemas, then ran extracted-package trust, reconciliation, producer-to-Plan Graph-to-Execution Graph, lifecycle and MCP transport regressions successfully. The source-alignment result is `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT` / `PASS_EXACT_ARCHIVE_ENTRY_BYTES`. It explicitly reports `BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED`: source-byte equality is not a signed builder receipt or independent release approval.

RC.23 remains unchanged at SHA-256 `00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`; RC.24 remains unchanged at `125d785b897dee1b6758c8f6d3508c7930d2a87f357d1b953616e7043fb596c8`. Historical benchmark fixture v66 remains byte-identical at SHA-256 `c300d1c2d79c1ec40a02d0a312547ec39fb77bb6f3d3aee5b90fd0e479f3ae7c`. New fixture v67, `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v67.json`, has SHA-256 `217c86983b17636e9ed3d14c3eae064d76ca69a158210ed0eb78e1d8871570a1`; its 64 source pins match current bytes and its frozen graph, task identities, evidence oracle and scoring rubric remain unchanged.

## Implementation integrated in RC.25

- Rollout trust preflight now inspects the actual active process's open `agg-trust-configuration.db` file descriptor. It requires exactly one trust-ledger descriptor and one `workflow.db` descriptor, checks they refer to different file inodes, opens the ledger read-only, and evaluates both verifier and reviewer high-water records in one SQLite read snapshot. Effective configuration version, configuration fingerprint and provider ID must exactly match the latest durable record. Missing/open-unobserved ledger, schema failure, unrecorded version, rollback, version gap or same-version replacement fails closed. The local ledger remains weaker than an external monotonic checkpoint.
- Empty optional host JSON peer fields no longer disable a separately configured verifier/reviewer during cross-domain checks. An explicitly blank domain still fails its own loader and never falls back to legacy trust roots. Non-empty malformed or unresolved values still fail closed.
- Planner source revalidation now compares immutable URI SHA-256 with the independently stored expected digest. Conflicting digests block even when the URI hash matches current source bytes; sensitive diagnostics retain URI, detail, expected and observed digests separately.
- Negative/regression coverage includes unobserved next version, same-version provider substitution, anti-rollback, missing active ledger descriptor, blank/unresolved peer JSON, contradictory source digests, and the existing bad-signature/scope/replay/stale-snapshot/provenance mutation tests.
- Versioned benchmark fixture v67 records current source pins without editing v66 or older fixtures. The source pack and manifest were rebuilt as RC.25; RC.23 and RC.24 archive bytes were not rewritten.

The local E2E proves the technical path using isolated SQLite databases and disposable test-only Ed25519 roots: nine typed producers, source lineage, signed current-snapshot checks, evidence-backed Plan Graph, immutable plan pinning, reviewer identity checks and persisted Execution Graph proposals. Negative controls reject invalid signature/scope, replay, stale snapshot, altered provenance, missing evidence and unauthorized execution. `claimTruthVerified=0` and `independentAttestations=0` in local benchmark/readiness output remain non-authoritative; test-local trust does not become production trust.

## Validation record

| Command / check | Result | Evidence |
|---|---|---|
| `npm test` | Exit 0 | Log `/tmp/runalith-npm-test-rc25-integrated-trust-ledger-v67-20261028.log`, 46,525 bytes, SHA-256 `8109de931ef1a3ad6ed143784462fd2ff2251eeb2d9c251085923a5daac6a92f` |
| `npm run pack:runalith-mcpb` with `PLUGIN_BUNDLE_OUT` targeting this unique RC.25 path | Exit 0 | 854,080-byte archive; SHA-256 above; 93 entries / 74 manifest tools; extracted E2E and trust/reconciliation suites passed |
| `node scripts/verify-mcpb-source-alignment.mjs --bundle dist/runalith-1.0.9-rc.25-runtime-trust-ledger-and-evidence-integrity-20261028.mcpb --output /tmp/runalith-source-alignment-rc25-runtime-trust-ledger-and-evidence-integrity-20261028.json` | Exit 0; byte alignment pass | Report SHA-256 `d22c2a656d4e5c1e4056355f77d4fcc5146122f84583d9c926e97ca81601a9a4`; release eligibility still blocked |
| `npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.25-runtime-trust-ledger-and-evidence-integrity-20261028.mcpb` | Exit 0 | `MCPB_FAST_TEST=PASS`, runtime `ok/local-only-mcp`, 93 archive entries, manifest/runtime 74/74 tools |
| `npm run test:package-reproducibility` | Exit 0 | `PASS`; isolated packaging reproducibility and extracted-bundle regressions completed |
| `node --test tests/test-adaptive-goal-benchmark.mjs` | Exit 0; 15/15 | Versioned source pins, immutable prior fixture hashes, drift/traversal controls and frozen-oracle negatives pass |
| `npm run docs:generate-reference` | Exit 0 | `docs/MCP_REFERENCE.md` regenerated from 74 RC.25 tools |
| `npm run docs:check` | Exit 0 | 117 Markdown files and 336 local links checked; MCP reference parity 74/74 |
| `node scripts/build-static-site.mjs` | Exit 0 | Generated `site/index.html` from the checked-in template and RC.25 source inputs |
| `npm run site:check` | Exit 0 | RC.25 identity, versioned acceptance filename, 12 local links and 18 external link attributes validated |
| `node scripts/check-static-site.mjs --check-external-links` | Exit 0 | 16 distinct external URLs checked, 16 passed; the unpublished local RC.25 dossier is identified as local-only rather than linked to a current GitHub URL that returned 404 |
| `npm run docs:check:external` | Exit 0 | 117 Markdown files, 336 local links and 31 distinct external URLs checked; all 31 passed |
| `git diff --check` | Exit 0 | No whitespace errors after final dossier and site-template edits |

The first pre-successor full test run exposed the expected historical-fixture incompatibility after versioning `package.json`: immutable v66 reported `PROVENANCE_SOURCE_HASH_MISMATCH`. v66 was not edited. A v67 successor and current-source pin updates resolved this without weakening the hash verifier; the subsequent complete `npm test` returned exit 0.

## Current live-state evidence — read-only

Fresh report: `/tmp/runalith-live-reconcile-rc25-sensitive-20261028.json`, generated `2026-10-28T06:01:26.529Z` (13:01:26 +07:00), mode `0600`, 7,234,927 bytes, SHA-256 `22bdae48cfecbfd82d81d5beba2e2804ad9c9fb20f22d169fc2b9ffe4289d6fe`. It is diagnostic evidence, not lifecycle authorization.

| Current database count | Value |
|---|---:|
| Jobs | 137 |
| Tasks | 1,277 |
| Events | 5,308 |
| Results | 908 |
| Artifacts | 867 |
| Attempts | 982 |
| Approvals | 119 |
| Task lease rows | 0 |

The selected live snapshot contains 85 matching jobs without selection truncation: 60 classified `stale_candidate_reconciliation_required`, 18 `awaiting_proposal_or_approval`, and 7 `awaiting_dispatch`. The previous state inventory recorded 60 executing/active jobs and 61 running tasks. The current reconciliation finds 60 jobs with running tasks but no active leases. **No active lease is not proof that a worker died.** Do not bulk-reset, terminalize, drain or dispatch these rows; each transition still needs correlated current event/attempt/result/artifact/provider/runtime/owner lineage and appropriate authority.

Current Goal/Idea/Plan/Execution findings:

- Two persisted Goal/Idea graphs have no evidence references (`KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY`); attestation count is zero, claim truth and independence are false, and independent signature verification was not attempted.
- The database contains 15 graph nodes/revisions/memberships, 16 edges and two goals. Planner inventory contains 63 runs and 373 evidence records; 28 rows self-report verified lineage, but zero report verified claims. Self-reported flags are not authority.
- Four planner findings are classified `PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID`. Reconciliation checks expected URI/detail digest against current bytes and emits a distinct conflict blocker when URI and stored details disagree.
- Three Plan Graph proposals contain 22 steps; all 22 steps lack supporting evidence, all three proposals lack authenticated current-snapshot binding and have unverified/non-independently-revalidated source evidence. No persisted Execution Graph proposal or execution-plan-candidate event was found.
- The current report identifies missing evidence/bindings; it does not modify graph artifacts or repair proposals. Fixes should create new versioned, producer-bound artifacts and proposals, not rewrite historical records.

## Remaining authority-dependent gates

All six RC.23 blockers remain open. The RC.25 preflight report used the actual installed RC.17 package as rollback baseline: `dist/runalith-1.0.9-rc.17-final2-candidate-20261028.mcpb`, SHA-256 `3ca54ac58c397695bde770ef979315b5f996abf25c9628602fefa7e41c69bc64`. Its extracted file parity against the current installed generation passed (93/93). The preflight is nevertheless `BLOCKED`; no mutation or checkpoint transition was attempted.

Preflight report: `/tmp/runalith-preflight-rc25-runtime-trust-ledger-and-evidence-integrity-20261028-v2.json`, mode `0600`, 552,230 bytes, SHA-256 `6db5158aac375ce3c068d4065c3ef02e7332405adf74aa2abc44f07c0a1e8437`, exit code 3 (expected fail-closed result), `readOnly=true`, `liveMutationPerformed=false`, and `externalSecurityStoreMutationPerformed=false`.

| Blocker | Evidence/action still required |
|---|---|
| `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` | The Phase 2 contract owner must supply the canonical versioned manifest listing exactly 71 approved paths, signed under an independently administered trust root, plus the builder receipt binding those paths, candidate bytes and source snapshot. No matching authoritative manifest is present; the archive's 93 total entries do not establish the 71-path contract. |
| `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` | Release/build authority must issue candidate-bound signed builder provenance, independent verifier evidence, and a release approval over exact candidate, installed baseline, rollback bytes and host-issued one-time nonce. A local SHA-256, tests, source alignment or dossier cannot replace this. `/etc/runalith/release-policy.json` is absent. |
| `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` | Host/security owner must provision and independently administer both versioned JSON trust configs, with distinct verifier/reviewer providers and non-overlapping keys, schema validation, version pinning, validity windows, rotation/revocation and the actual host-owned anti-rollback ledger. Inspect effective runtime config and its open ledger after host provisioning. Current installed plugin is RC.17 with empty plugin `config`; production configs were not verified. |
| `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` | Security authority must provision `/etc/runalith/external-checkpoint-trust.json` and an independent monotonic external store/adapter, then provide signed nonce-bound continuity/CAS receipts for the exact prior and candidate checkpoint. A local SQLite ledger is not an external anchor. The preflight did not attempt to advance any checkpoint. |
| `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` | Workflow owners/providers must correlate each executing job with current event, attempt, result, artifact, owner, provider, runtime and lease state, then perform only authorized normal lifecycle completion or cancellation and re-run read-only reconciliation. No drain or lifecycle change was performed. |
| `RUNNING_TASKS_MUST_DRAIN` | Owner/provider/runtime must resolve all 61 running task records from current lineage and worker/provider confirmation. Missing leases alone do not prove dead workers. No reset, terminalization, kill, drain or dispatch was performed. |

Safe sequence: provision the authority-owned contract/configs/ledger externally; verify signed evidence against the exact RC.25 archive; independently reconcile and resolve every live job/task with its owner; rerun read-only reconciliation and the rollout preflight against the real rollback baseline; require zero blockers and independent approval before any host UI activation. Do not activate RC.25 on the basis of this acceptance document.
