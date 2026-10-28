# Runalith RC.27 rollout dossier — 2026-10-28

## Decision

**`BLOCKED`; do not activate RC.27 or dispatch production.** RC.27 is a versioned successor to RC.26 that binds a new machine-readable AGG readiness dossier compiler and its negative tests into the source snapshot. The MCP runtime implementation is carried forward unchanged; this successor does not claim to fix missing production evidence, create trust, drain workflows, or authorize activation.

## Candidate identity and release boundary

- Candidate output: `dist/runalith-1.0.9-rc.27-agg-readiness-dossier-20261028.mcpb`.
- Runtime entry point: `server/index-v1.0.9-rc.27.js`.
- Intended rollback baseline: the exact installed RC.26 candidate archive, `artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb`, SHA-256 `72941422ee790e9ca602305bf1ec08abfde222b40d1e54e9026856934cc43d9a`.
- RC.27 is a candidate only. This work does not install it, change the host registry, restart the runtime, mutate the live workflow database, or advance the external checkpoint.
- The candidate digest, source snapshot digest, archive inventory, exact source-to-bundle report, MCP fast-test output and fresh preflight report must be recorded in the generated machine-readable dossier. A source-alignment PASS is byte identity only, not an authenticated builder receipt or independent release approval.

## Integration change

`scripts/build-agg-readiness-dossier.mjs` composes the live read-only reconciliation report, exact candidate/source-alignment report, rollout preflight, dedicated Goal/Idea snapshot observation and trust-configuration status into one machine-readable decision. It validates that the candidate digest is consistent across alignment and preflight; rejects a self-promoted graph verification; keeps all six RC.23 gates open unless the current preflight explicitly reports them absent, and even then records them as not closed by the supplied evidence; and links findings to their source reports and record IDs.

The dossier retains source-hash mismatches with their historical record identity and explicitly unknown cause. It captures workflow/task lineage, owner/provider/runtime/lease uncertainty, and only proposes `HOLD_FOR_OWNER_RECONCILIATION`. It does not perform repairs or lifecycle actions. Trust-domain separation booleans cannot promote trust when both domains are unavailable or have no roots.

## Current observed blockers

The latest RC.26 read-only observations recorded in this work session show:

- The Goal/Idea graph `runalith-agg-e2e-20261026-clean` has 7 nodes, 7 edges and 7 memberships with an integrity-valid snapshot, but zero evidence references and an empty evidence manifest. Snapshot hash: `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3`.
- The verifier config `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` and reviewer config `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` are both blank in the effective runtime. No provider or trust roots are configured for either domain.
- Current reconciliation observes 4 planner source-hash mismatch findings, 65 planner runs, 373 evidence records with zero verified claims, 3 Plan Graph proposals with 22/22 steps missing supporting evidence, 3 proposals without authenticated current-snapshot binding, and 0 persisted Execution Graph proposals.
- The workflow database has 138 jobs, 1,277 tasks, 5,309 events, 908 results, 867 artifacts, 982 attempts, 119 approvals and zero lease rows. The selected read-only inventory identifies 60 executing jobs and 61 running tasks without active leases. Missing leases do not prove worker death.
- The host-managed runtime is still RC.26. RC.27 has not been installed or activated.

These are observed findings, not authority to mutate the graph or workflow lifecycle. Use the read-only commands and dossier compiler below to refresh the evidence before making any decision.

## Reproducible read-only workflow

```sh
node scripts/reconcile-active-workflows.mjs \
  --db "$HOME/.chat-on-steroids/agent-orchestrator/workflow.db" \
  --limit 200 --out artifacts/adaptive-goal-graph/live-reconciliation-<unique>.json

node scripts/verify-mcpb-source-alignment.mjs \
  --bundle dist/runalith-1.0.9-rc.27-agg-readiness-dossier-20261028.mcpb \
  --output artifacts/adaptive-goal-graph/source-alignment-<unique>.json

node scripts/runalith-rollout.mjs preflight \
  --candidate dist/runalith-1.0.9-rc.27-agg-readiness-dossier-20261028.mcpb \
  --rollback-bundle artifacts/runalith-1.0.9-rc.26-solo-graph-20261028.mcpb \
  --report artifacts/adaptive-goal-graph/rollout-preflight-<unique>.json

node scripts/build-agg-readiness-dossier.mjs \
  --alignment artifacts/adaptive-goal-graph/source-alignment-<unique>.json \
  --reconciliation artifacts/adaptive-goal-graph/live-reconciliation-<unique>.json \
  --preflight artifacts/adaptive-goal-graph/rollout-preflight-<unique>.json \
  --snapshot artifacts/adaptive-goal-graph/live-goal-snapshot-<unique>.json \
  --trust-status artifacts/adaptive-goal-graph/live-trust-status-<unique>.json \
  --out artifacts/adaptive-goal-graph/agg-readiness-dossier-<unique>.json
```

The `<unique>` suffix must be replaced with one identical, new timestamp/token for the entire observation set. Never overwrite earlier reports. The sensitive `--include-sensitive-source-identifiers` reconciliation output belongs in access-controlled storage; do not put raw historical source paths into a public dossier.

## Six RC.23 gates and authorities

| Gate | Required external input / owner | Safe verification before considering closure |
|---|---|---|
| `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` | Phase 2 contract owner supplies the owner-signed canonical 71-path manifest; controlled builder supplies a candidate-bound receipt; platform security provisions the host-pinned custody policy. | `node scripts/verify-phase2-custody-evidence.mjs` plus read-only preflight; exact 71-path and byte equality, valid authority signatures, pinned roots and exact candidate/source bindings. |
| `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` | Independent builder, verifier and release authority; host-issued one-time nonce and exact candidate/baseline/rollback binding. | Hosted provenance, independent verification and release approval verify under host-owned policy. Local hashes and tests are not sufficient. |
| `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED` | Host/security administrator and two independently administered authorities. | Validate both exact versioned JSON documents as a pair, then inspect effective runtime configuration and both version/fingerprint ledger histories. See [production trust provisioning](agg-production-trust-provisioning-runbook.md). |
| `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` | Host security authority and independently operated checkpoint-store authority. | Verify root-owned policy/adapter, disjoint authority and store-attestation roots, protected monotonic continuity and fresh signed nonce-bound CAS/commit receipts. Do not call `--advance-external-checkpoint` during diagnostics. |
| `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN` | Each workflow owner and provider/runtime operator. | Record-by-record event → attempt → result/artifact → runtime/lease reconciliation with an authoritative outcome. Missing lease or old activity alone is insufficient. |
| `RUNNING_TASKS_MUST_DRAIN` | Each task owner plus provider/runtime and lease authority. | Confirm exact worker/provider run and matching durable result/completion lineage; rerun reconciliation and show no unresolved running tasks. |

Additional candidate/host gates (rollback parity, installed-version collision, or changed host baseline) remain separate. No gate is closed by omission, a test-local trust identity, or the fact that the runtime health check returns `ok`.

## Validation expectations

- `npm test`, `npm run test:agg-readiness-dossier`, and `npm run solo:graph`.
- Trust configuration, reviewer identity, knowledge verifier, evidence lineage, current-scope E2E, reconciliation and rollout negative/regression suites.
- `npm run verify:mcpb-source-alignment -- --bundle <candidate>` is not a valid invocation; use the exact CLI shown above (`node scripts/verify-mcpb-source-alignment.mjs --bundle ... --output ...`).
- `npm run test:mcpb-candidate -- <candidate>`, `unzip -t <candidate>`, SHA-256, package reproducibility, docs checks and `git diff --check`.
- Fresh read-only rollout preflight must remain `BLOCKED` until the external authority and live-state gates have independently verified evidence. Exit code 3 is the expected result for a blocked decision.

**Rollout status: `BLOCKED`.** The new dossier compiler improves traceability and prevents evidence omission from being mistaken for gate closure. It cannot supply the owner-signed contract, independent release signatures, production trust roots, external anchor, or workflow/task dispositions.
