# Goal/Idea Graph → Plan Graph → Execution Graph acceptance — RC.17 (2026-10-28)

## Decision

**Candidate package checks: PASS. Isolated three-graph E2E: PASS. Live proposal: BLOCKED. Production dispatch: NOT RUN / NOT AUTHORIZED. Release: BLOCKED.**

RC.17 repairs two local integration defects without relaxing trust or evidence gates:

1. The prior MCPB manifest exposed no user_config surface for the versioned Goal/Idea verifier and action-intent reviewer trust documents, so an administrator had no manifest-defined inputs to pass into the child process. RC.17 declares two optional JSON fields and maps them to AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON and AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON. These fields are only a transport surface; neither the UI nor updated_by metadata authenticates an administrator or grants authority. Effective host interpolation remains unproven until the newly installed runtime reports both trust domains configured and they are independently checked for authority, scope, disjoint provider IDs/root fingerprints, anti-rollback ledger and key lifecycle.
2. The knowledge verifier previously threw while constructing a snapshot attestation request when an evidence manifest was absent or could not be resolved. It now preserves a diagnostic snapshot response with eligibleForAttestation=false and explicit attestationBlockers. Empty evidence emits KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY; an experiment without durable evidence retains KNOWLEDGE_ACTION_EVIDENCE_MISSING; invalid lineage is similarly surfaced. Attestation ingestion still rejects these states and never persists a successful verification. A malformed or empty optional host JSON field reports AGG_TRUST_CONFIG_NOT_CONFIGURED and cannot trigger legacy-key fallback.

RC.17 also adds startup file identities to orchestrator_health: selected entry-point path, SHA-256 of entry-point bytes and effective manifest bytes, startup timestamp, and the explicit semantics label startup_file_hashes_only_not_package_digest_or_signed_provenance. These hashes are useful for reconciling installed files against the archive, but are not an archive digest, authenticated build receipt, trust proof or approval.

## Candidate identity and source alignment

- Source package version: 1.0.9-rc.17.
- Entry point: server/index-v1.0.9-rc.17.js.
- Final candidate: dist/runalith-1.0.9-rc.17-final2-candidate-20261028.mcpb.
- Candidate SHA-256: 3ca54ac58c397695bde770ef979315b5f996abf25c9628602fefa7e41c69bc64.
- Size: 843,882 bytes; 93 archive entries; manifest/runtime tools: 74/74.
- Source snapshot SHA-256: de1152cc1c0700145865f2f54c9b9d0fdbc37682dbe5fddbd3a47204fbab5e83.
- Source-alignment report: /tmp/runalith-source-alignment-rc17-rollout-final-20261028.json, SHA-256 149e47d19c5a63663fb491d0bf9ce0a4b93c677e0d11e61ac6ba98e62ec4a912.
- Source-to-bundle alignment: PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT; ZIP integrity passed. The report explicitly retains DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT and BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED.
- Historical RC.16 archives were not overwritten. RC.17 is a fresh candidate, not production activation.

## Verification performed

- npm test: PASS, exit 0; log /tmp/runalith-npm-test-rc17-final2-20261028.log, SHA-256 ae9ec9e847e311a03ff94d68c4daca65c90ee1f83245c3e31827b9a3dad464da. It includes trust configuration/entrypoint, graph projection and readiness, immutable Execution Graph proposal verification, current-scope producers, reviewer identity, evidence lineage, benchmark v60 (15/15), rollout (15/15), telemetry, MCP, dashboard and the historical Phase 2 archive regression.
- npm run test:package-reproducibility: PASS after building the final2 candidate; the test confirmed the package output is reproducible under the repository's current packaging contract.
- Package build (npm run pack:runalith-mcpb): PASS; the build checks the ZIP itself, archive entries against source bytes or the documented package.json projection, manifest/tool-schema boundary, and archive-extracted tests.
- npm run test:mcpb-candidate -- dist/runalith-1.0.9-rc.17-final2-candidate-20261028.mcpb: MCPB_FAST_TEST=PASS, exact candidate hash above, isolated temporary DB, runtime ok/local-only-mcp, 74/74 tools.
- Archive-extracted MCP stdio/lease/process/backpressure/shutdown regressions: PASS.
- Archive-extracted trust tests: PASS for wrong signature, wrong scope, stale snapshot, nonce replay, historical provenance tampering, trust-root separation, rotation/revocation and anti-rollback. Test-generated keys are disposable test authority only.
- Source Goal/Idea producers → nine-node Plan Graph DAG → durable readiness → review-only Execution Graph proposal: PASS in disposable SQLite state. Typed artifacts resolve to producer task, result, attempt and completion lineage; immutable plan pin, reviewer identity and separate test approval are checked. Dispatch is exercised only inside that isolated E2E. The report explicitly keeps productionAuthorityGranted=false.
- Empty/invalid evidence regression: PASS. Empty evidence remains diagnosable, a signed empty manifest is denied, and no verifier record is created.
- Benchmark successor benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v60.json: SHA-256 9b2a5838c4141cfa4b3ea16c2afea5777eb509bcdc04fb8059ab916d13e2b184; 64 source pins, preserving the evidence-store cap. Historical v59 remains byte-for-byte unchanged at SHA-256 0728a350c32908857a959cfef7e3287d5ec26469239cf1806ceae7abc572443e.
- npm run docs:generate-reference: PASS (74 tools). Final npm run docs:check: PASS (101 Markdown files / 332 local links). npm run site:check: PASS (12 local links, 19 external links, 17 unique external URLs, 74 tools, RC.17 entrypoint and acceptance link). git diff --check: PASS.
- Final read-only rollout preflight for the exact final2 candidate and the prior RC.16 rollback archive: BLOCKED, canActivateNow=false. Report /tmp/runalith-preflight-rc17-final2-20261028.json, SHA-256 62803734af97d58b123520e1cc77ce47b3084837a9ee35e32bfa3e58840e60b5. readOnly=true, liveMutationPerformed=false, externalSecurityStoreMutationPerformed=false, checkpoint transition not requested.

## Live state — read-only observation, not an acceptance substitute

The most recent live reconciliation used a read-only SQLite connection and created no workflow, graph, lease, approval, trust or lifecycle mutations.

- Report: /tmp/runalith-live-reconcile-rc17-20261028.json.
- Report SHA-256: c9fceea0aabe0a324e5d82d4cde56ffe32ff6e08a1abfea635e48b220e24dc25.
- 85 jobs considered: 7 awaiting dispatch, 18 awaiting proposal/approval and 60 stale_candidate_reconciliation_required; 60 jobs have running tasks but no active lease rows in the observed DB. This is a reconciliation queue, not proof that workers are dead; every job/task needs authoritative runtime/provider/owner review before any lifecycle change.
- Two persisted Goal/Idea graphs remain structurally inspectable, with 0 attestations and no planning authority: runalith-agg-e2e-20261026 (8 nodes / 9 edges) and runalith-agg-e2e-20261026-clean (7 nodes / 7 edges).
- The report has 3 stored Plan Graph proposals, 22 observed Plan Graph steps, 22 missing supportingEvidenceRefs, 3 proposals without authenticated current snapshot binding and independent signature revalidation, and 0 persisted Execution Graph proposals.
- Four planner evidence rows report source bytes verified but now fail current source hash validation. They remain untrusted; a previous self-reported success is not current evidence.
- The active runtime/source package before RC.17 installation still reports AGG_TRUST_CONFIG_NOT_CONFIGURED / KNOWLEDGE_VERIFIER_NOT_CONFIGURED. RC.17 manifest fields and tests do not prove host-managed injection or that either independent trust authority has provisioned its config.
- The live host is still RC.16 (PID 37032; entry point /home/long/.config/chat-on-steroids/plugins/7ab6b442-ac29-4a10-b850-1b11c08efd81/g-uRZ7jt/server/index-v1.0.9-rc.16.js; entry-point SHA-256 6b5223231fa2d21dcdc7f22e5e5b0ac3c90a9daee50737a41ba724f591c83ea0; registered archive dist/runalith-1.0.9-rc.16-goal-plan-execution-e2e-20261028.mcpb SHA-256 bb2744fdfc953ba46b73b690af26d1300cf442d8a57e2921b2fe474c9cd808ff). RC.16 does not report the new runtime file identity; no RC.17 package-hash claim is inferred from version alone. A live verified graph search reproduced KNOWLEDGE_GRAPH_NOT_VERIFIED: KNOWLEDGE_VERIFIER_NOT_CONFIGURED. The clean 7-node graph has zero evidence refs; the other persisted graph is blocked by KNOWLEDGE_ACTION_EVIDENCE_MISSING.

## Required owner/admin work before live proposal and dispatch

1. Install/activate this candidate through the host-managed package mechanism only when an authorized host administrator chooses to do so. This repo does not edit the live plugin registry, installed generation, process environment or runtime.
2. Through the host-supported configuration UI or administrator-controlled environment mechanism, provide the exact externally approved goal_idea_verifier and action_intent_reviewer JSON documents. Public Ed25519 keys only. Use distinct independently administered provider IDs, disjoint canonical SPKI fingerprints and monotonically versioned configs. Validate both documents together with scripts/validate-agg-trust-config.mjs using --domain, --config and --peer-config before provisioning; do not generate replacement trust roots here. If the host ignores user_config interpolation, set the two variables through its supported process configuration mechanism and verify effective status over MCP.
3. Read orchestrator_health.runtime_identity from the new active runtime and compare both startup hashes with exact extracted archive entries. Then call adaptive_goal_trust_configuration_status; require expected domains, fingerprints/key IDs/scopes, independent provider identities, current validity windows, accepted change references and durable anti-rollback ledger. Configuration status alone is not proof the signing services are independent.
4. Rebuild the new Goal/Idea graph from actual active typed artifacts and current producer/result/attempt/completion lineage. Do not add evidence references to a historical node just to clear the blocker, relabel prior claims, or repair historical plan hashes in place. Each experiment/action must bind real artifact:// evidence; the independent verifier must adjudicate claim truth/independence and sign the exact current snapshot and evidence-manifest hash. Verify readback and re-run verified knowledge search.
5. Project the authenticated candidate to Plan Graph. Read back every step and confirm supportingEvidenceRefs resolves and binds the expected evidence. Run compatibility and readiness separately; contract_ready_evidence_pending is not ready, and contractReady=true never implies evidenceReady=true.
6. Create and read back the review-only Execution Graph proposal against the exact immutable Plan Graph proposal/hash. Require the separately administered reviewer identity and approval for the exact candidate and immutable plan, then re-run readiness. Only the normal controlled lifecycle may dispatch after all authority, task, artifact and live-workflow gates pass.
7. Before any workflow state transition, reconcile every EXECUTING job and running task against authoritative owner, active runtime/process, provider run, lease fencing, attempt/result/completion event and artifact lineage. Do not bulk reset, terminalize, cancel, retry or redispatch records on the basis of age or missing leases.

## Release status

**BLOCKED.** Local tests and live file alignment do not supply the missing independent source-verifier signature, action reviewer approval, authenticated build receipt/release approval, host trust configuration or external trust-ledger anchor. Live proposal creation and production dispatch were not attempted because preconditions are not met. No live plugin config/registry edit, runtime restart/kill, live workflow database write, package activation or production dispatch occurred.

See the [RC.17 rollout dossier](runalith-rollout-rc17-20261028.md) for the exact six-blocker owner action list and safe activation sequence.
