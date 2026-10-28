# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.21

## Decision

**Isolated end-to-end integration: PASS. Read-only live reconciliation: pending final RC.21 report. Production readiness: BLOCKED.** RC.21 is a substantive follow-up to RC.20: persisted Plan Graph reconciliation now requires complete coverage of every actionable Goal/Idea source node and rejects dependency edges whose actionable prerequisite was omitted. The versioned runtime entrypoint remains byte-identical to RC.20; no runtime dispatch behavior changed.

## Candidate identity

- Candidate: `dist/runalith-1.0.9-rc.21-actionable-source-coverage-20261028.mcpb`
- SHA-256: `325564a510593810ad670a03e8516a2e56f66d2b95951dbd3df2fc5ceb10f16f`
- Size: 851,182 bytes; 93 archive entries; 74 manifest/runtime tools.
- Entry point: `server/index-v1.0.9-rc.21.js`, SHA-256 `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1`.
- Source snapshot SHA-256: `56cb8d57ca4d0a93c777d1b5cec346c2fb9a7d595f68780ad32e22bf86e67379`.
- Source-alignment report: `/tmp/runalith-source-alignment-rc21-actionable-source-coverage-20261028.json`, SHA-256 `3b728b1714fd584c3ce0314c73152daeae0ea316104cbcfd6c95a32cc1a9a35b`. Result `PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT`, 93 archive entries, 92 exact source-byte matches and one generated metadata projection; authenticated release eligibility remains blocked.
- Benchmark successor: `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v63.json`, SHA-256 `9012aeca46569d9c8851150cf92f1be9a4903cb97baa0c2895cbf88526874868`. v59–v62 are preserved byte-for-byte.
- Full `npm test`: exit 0. Log `/tmp/runalith-npm-test-rc21-actionable-source-coverage-20261028.log`, SHA-256 `03d303f8d728ce84f08d6ff5a0615b8ce39fe162c51123d9d92fb7da3dc1ed2f`.
- MCPB pack: source-to-bundle byte alignment PASS; extracted MCP handshake and 74/74 tool schemas PASS; trust, reconciliation and isolated three-graph E2E regressions PASS.
- MCP fast test: `MCPB_FAST_TEST=PASS`; package reproducibility and ZIP integrity are checked separately.

The runtime entrypoint is byte-identical to RC.20. This candidate changes diagnostics/tests/package identity, not the execution runtime. Local source alignment does not authenticate publisher provenance; source tree is dirty and there is no authenticated builder receipt or independent release approval.

## RC.21 implementation change

In `scripts/reconcile-active-workflows.mjs`, each persisted Plan Graph proposal is checked against its recorded source graph:

- Every source `task`/`experiment` node must map to exactly one Plan Graph step (`SOURCE_ACTION_NODE_NOT_PROJECTED`).
- Every source dependency edge with an actionable endpoint must preserve the required step mapping and prerequisite (`SOURCE_GRAPH_PREREQUISITE_NOT_PROJECTED`). An edge is no longer silently skipped just because one mapped endpoint is missing.
- Existing checks still cover duplicate/unresolved source IDs, actionable source types, step dependencies, dependency ordering, projected `requires_all` / `depends_on` edges, source/draft hashes, supporting evidence declarations, and authenticated current-snapshot binding.

This closes a consistency gap where a persisted proposal could retain a locally valid subset of steps while omitting an actionable source branch. The diagnostic remains read-only and does not rewrite the Plan Graph, add evidence, infer truth, or authorize dispatch.

## Integration and regression evidence

- `tests/test-reconcile-active-workflows.mjs`: missing source action projection, dependency-edge projection, source lineage, self-hashed schema-invalid typed artifacts, stale/missing cross-graph bindings, bounded inventory HOLD, active lease outside recent history, and task DAG cycles.
- `tests/test-adaptive-goal-current-scope-producer-e2e.mjs`: nine isolated producers → typed durable artifacts → signed current Goal/Idea snapshot → Plan Graph DAG and `supportingEvidenceRefs` → persisted Execution Graph proposal → immutable plan pin → separately trusted reviewer identity/approval → controlled isolated lifecycle. Negative path recomputes unkeyed source-verification/proposal/wrapper hashes around forged serialized verification metadata; graph/candidate readback, approval and dispatch still fail closed.
- `tests/test-runalith-rollout.mjs`: `EXECUTING` jobs count toward drain regardless of inconsistent status metadata.
- `tests/test-adaptive-goal-benchmark.mjs`: v63 source pins preserve the ground-truth oracle; historical fixtures remain immutable.

## Live read-only reconciliation and rollout

- Reconciliation: `/tmp/runalith-live-reconcile-rc21-actionable-source-coverage-20261028.json`, SHA-256 `5d87c6fab7a723bbdf9232429928c9c54895a381fc97f9a6b7d9a8a733e3b058`.
- Preflight: `/tmp/runalith-preflight-rc21-actionable-source-coverage-20261028.json`, SHA-256 `72184224984d016ddfacf2a3a1024bc06ea5229c09303d190ea22118c9ec7b7e`.
- Preflight decision: `BLOCKED`, exit code `3`, `canActivateNow=false`, read-only, no live mutation, external checkpoint transition `NOT_REQUESTED`.

The RC.21 live reconciliation confirms 137 jobs, 1,277 tasks, 5,308 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and zero lease rows. It observes 60 jobs requiring owner/provider/runtime reconciliation, 61 running tasks, two Goal/Idea graphs with empty evidence manifests, three Plan Graph proposals / 22 steps without `supportingEvidenceRefs`, three missing authenticated current-snapshot bindings, four invalid current source-hash references and zero Execution Graph proposals. The RC.20 report is not promoted to RC.21 evidence; the report above was collected after the implementation change.

The six authority gates remain unchanged:

| Brief gate | Current preflight blocker | Closure authority / required evidence |
|---|---|---|
| `PHASE2_AUTHORITY_INPUTS_MISSING` | `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` | Owner-signed canonical manifest of exactly 71 sorted unique portable paths; controlled-builder receipt bound to exact candidate/source/tree and all path bytes; host-pinned distinct manifest-authority/builder roots. Do not trim a 93-entry archive. |
| `RELEASE_PROVENANCE_AND_APPROVAL_MISSING` | `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` | Independently signed SLSA/DSSE provenance, verification envelope and approval bound to candidate, installed baseline and rollback hashes, plus host-issued one-time nonce. |
| `HOST_MANAGED_TRUST_CONFIG_NOT_PROVISIONED` | `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` | Separate verifier/reviewer administrators provision versioned public-only JSON configs, distinct provider IDs and disjoint canonical Ed25519 SPKI roots/scopes; verify effective runtime config and anti-rollback ledger. |
| `HOST_MANAGED_CHECKPOINT_CONTINUITY_NOT_VERIFIED` | `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` | Host-owned authenticated adapter, independently protected monotonic store, distinct checkpoint/store-attestation roots, fresh signed continuity, nonce consumption and CAS commit receipt. |
| `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` | `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` | Per-job owner/provider/runtime and event/attempt/result/artifact/lease reconciliation with authorized lifecycle disposition. |
| `RUNNING_TASKS_MUST_DRAIN` | `RUNNING_TASKS_MUST_DRAIN` | Per-task attempt/result/completion/artifact lineage, provider runtime identity and authoritative lease/owner epoch. Missing lease is not proof of worker death. |

Preflight retains the existing blocker codes for backward compatibility. No production host configuration, registry, process, live graph/workflow DB or external checkpoint was changed. Do not activate or dispatch until every gate is independently closed.
