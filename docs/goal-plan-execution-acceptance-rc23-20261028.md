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
