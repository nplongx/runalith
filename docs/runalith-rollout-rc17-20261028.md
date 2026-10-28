# Runalith RC.17 rollout dossier — 2026-10-28

## Rollout decision

**BLOCKED — do not activate or dispatch production workflows.**

The RC.17 candidate passes source tests, isolated three-graph E2E, archive smoke, exact source-byte alignment, ZIP integrity and documentation checks. The host is still running RC.16 and the live Goal/Idea verifier and action reviewer are not configured. The rollout preflight is read-only and returns six unresolved blockers. This dossier distinguishes test-local chain results from live proposal readiness and production dispatch.

## Candidate and provenance

| Item | Verified value |
|---|---|
| Candidate | dist/runalith-1.0.9-rc.17-final2-candidate-20261028.mcpb |
| SHA-256 | 3ca54ac58c397695bde770ef979315b5f996abf25c9628602fefa7e41c69bc64 |
| Size / archive entries | 843,882 bytes / 93 |
| Package version / entry point | 1.0.9-rc.17 / server/index-v1.0.9-rc.17.js |
| MCP tools | 74 manifest / 74 runtime |
| Source snapshot SHA-256 | de1152cc1c0700145865f2f54c9b9d0fdbc37682dbe5fddbd3a47204fbab5e83 |
| Source alignment | PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT |
| Source-alignment report | /tmp/runalith-source-alignment-rc17-rollout-final-20261028.json |
| Source-alignment report SHA-256 | 149e47d19c5a63663fb491d0bf9ce0a4b93c677e0d11e61ac6ba98e62ec4a912 |
| Package fast test | MCPB_FAST_TEST=PASS, isolated temporary DB, runtime ok/local-only-mcp |
| Full npm test log SHA-256 | ae9ec9e847e311a03ff94d68c4daca65c90ee1f83245c3e31827b9a3dad464da |
| Benchmark v60 fixture SHA-256 | 9b2a5838c4141cfa4b3ea16c2afea5777eb509bcdc04fb8059ab916d13e2b184 |
| Historical v59 fixture SHA-256 | 0728a350c32908857a959cfef7e3287d5ec26469239cf1806ceae7abc572443e (unchanged) |

The local build reports DIRTY_GIT_TREE_BYTES_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT; a byte-aligned candidate is not an authenticated release. The reproducibility test passes under the repository's current packaging contract, but does not replace independently signed builder provenance or release approval.

Final documentation gate: 101 Markdown files / 332 local links; static-site gate reports 74 tools and the RC.17 entry point/acceptance link. git diff --check passes.

## Root-cause fixes delivered in RC.17

1. The MCPB manifest exposes optional blank-default user_config fields for the versioned Goal/Idea verifier JSON and action-intent reviewer JSON, mapped to their actual process environment variables. An unresolved or blank host placeholder reports AGG_TRUST_CONFIG_NOT_CONFIGURED; legacy single-key fallback is denied when the JSON input is present. The config UI is only transport—not administrator authentication, trust authority, or approval.
2. orchestrator_health reports startup SHA-256 hashes for the selected entry point and effective manifest, with an explicit label that these are not an archive digest or signed provenance. This allows an installed RC.17 runtime to be reconciled against the exact extracted candidate.
3. An empty or invalid Goal/Idea evidence manifest remains diagnosable but cannot be attested. eligibleForAttestation=false and explicit blockers are returned; empty-evidence signatures are denied and not persisted. Existing evidence/signature/lineage validation remains fail-closed.
4. Tests cover blank/unexpanded host config, config-domain separation, signatures/scopes, replay, snapshot drift, key rotation/revocation, evidence lineage and empty manifest denial. The v60 source-pin successor respects the 64-reference limit and leaves v59 immutable. Historical archive test scope explicitly excludes current RC.17 work candidates without changing any legacy archive hash.

## Three-graph acceptance

**Test-local E2E: PASS.** In a disposable SQLite DB, nine actual producer tasks emitted typed artifacts with result/attempt/completion lineage; a Goal/Idea snapshot was verified by an isolated test-only key; the nine-node Plan Graph had role bindings and dependency preservation; readiness passed; a review-only Execution Graph proposal was persisted/read back with immutable plan pin and a separate test reviewer identity. The sandbox report explicitly says productionAuthorityGranted=false. This is not evidence of an authorized live or production dispatch.

**Live proposal: BLOCKED.** Live verified search reproduces KNOWLEDGE_GRAPH_NOT_VERIFIED: KNOWLEDGE_VERIFIER_NOT_CONFIGURED. Trust status reports:

- Goal/Idea verifier: KNOWLEDGE_VERIFIER_NOT_CONFIGURED, no provider, fingerprint or trusted roots.
- Action-intent reviewer: AGG_TRUST_CONFIG_NOT_CONFIGURED, no provider, fingerprint or trusted roots.

The clean persisted graph has 7 nodes and no evidence refs; the other persisted graph has an experiment without a durable artifact:// reference. The last read-only reconciliation found 3 Plan Graph proposals, 22 observed steps and 22 steps without supportingEvidenceRefs, 3 proposals without authenticated current snapshot binding, and 0 Execution Graph proposals. Four planner evidence records that previously reported source-byte verification now fail current source-hash validation.

## Latest live identity and read-only preflight

The active host runtime is still 1.0.9-rc.16, PID 37032, entry point:

/home/long/.config/chat-on-steroids/plugins/7ab6b442-ac29-4a10-b850-1b11c08efd81/g-uRZ7jt/server/index-v1.0.9-rc.16.js

- Installed entry-point SHA-256: 6b5223231fa2d21dcdc7f22e5e5b0ac3c90a9daee50737a41ba724f591c83ea0.
- Registered RC.16 archive: dist/runalith-1.0.9-rc.16-goal-plan-execution-e2e-20261028.mcpb.
- Registered archive SHA-256: bb2744fdfc953ba46b73b690af26d1300cf442d8a57e2921b2fe474c9cd808ff.
- RC.16 health has no runtime_identity field; the RC.17 package hash cannot be inferred from version metadata alone.

Final2 candidate preflight:

- Report: /tmp/runalith-preflight-rc17-final2-20261028.json.
- Report SHA-256: 62803734af97d58b123520e1cc77ce47b3084837a9ee35e32bfa3e58840e60b5.
- status=BLOCKED, canActivateNow=false, readOnly=true, liveMutationPerformed=false, externalSecurityStoreMutationPerformed=false, external checkpoint NOT_REQUESTED.
- Read-only job reconciliation: /tmp/runalith-live-reconcile-rc17-20261028.json, SHA-256 c9fceea0aabe0a324e5d82d4cde56ffe32ff6e08a1abfea635e48b220e24dc25; 85 jobs considered, 60 classified for owner/runtime reconciliation, 60 jobs with running tasks but no active lease. Missing lease is not proof of worker death.

## Six blockers — actions and owners

1. **PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED — Phase 2 contract owner, controlled builder, platform-security administrator.** Provide the authentic owner-signed canonical 71-path manifest and builder-signed receipt bound to the exact source commit/tree and candidate. Do not infer the path list or trim the 93-entry bundle to fit.
2. **INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED — controlled builder, independent verifier, release authority.** Provide the host-controlled release policy, signed SLSA provenance, independent verification envelope/test evidence, separate release approval for exact candidate/baseline/rollback, and host-issued one-time nonce.
3. **PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED — platform/security administrator and the two trust authorities.** Validate and provision the exact versioned JSON documents for independently administered verifier and reviewer services; distinct provider IDs and disjoint canonical SPKI fingerprints; current validity/revocation and monotone versions. Public keys only. Do not mint production keys in this repository.
4. **PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED — platform/security operator.** Provision the host policy and hash-pinned external checkpoint adapter, independently administered monotonic store, fresh signed store attestation under a distinct key, checkpoint continuity and signed CAS receipt.
5. **ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN — each of the 60 job owners plus provider/runtime operators.** Reconcile authoritative process/worker/provider/heartbeat state and correlated event/attempt/result/artifact lineage; require each owner's normal lifecycle disposition.
6. **RUNNING_TASKS_MUST_DRAIN — each running-task owner plus provider/runtime operators.** Reconcile each of the 61 running tasks against provider/runtime identity, lease fencing, attempt/result/completion events and artifacts. Do not bulk-reset, terminalize, cancel, retry or redispatch based on age or a missing lease alone.

## Safe rollout sequence after owner actions

1. An authorized host administrator installs the RC.17 candidate through the supported host mechanism; this repo has not modified registry/config or restarted the process.
2. Query orchestrator_health and compare runtime_identity.entry_point_sha256_at_startup and manifest_sha256_at_startup to exact entry-point and manifest bytes extracted from the candidate. Confirm these are actual file hashes, not version-derived claims.
3. Query adaptive_goal_trust_configuration_status; require both configured domains, independently approved provider identities, disjoint public roots/scopes, valid windows/revocation state and durable anti-rollback history.
4. Create a fresh evidence-backed Goal/Idea graph only from actual current durable artifacts. Obtain an independent verifier signature over the exact snapshot and resolved evidence manifest; read back and rerun verified search.
5. Create/read back the Plan Graph and confirm every step has appropriate supportingEvidenceRefs; evaluate structural compatibility and execution readiness separately. contract_ready_evidence_pending is blocked, and contractReady=true never means evidenceReady=true.
6. Create/read back an Execution Graph proposal bound to the exact immutable Plan Graph proposal/hash. Require the separately trusted action reviewer identity and approval for the exact candidate/plan. Only then may the normal controlled lifecycle dispatch if all remaining preflight and owner gates have passed.

## Final state

**Release remains BLOCKED.** No RC.17 host activation, live registry/config edit, process restart/kill, live workflow DB write, live graph mutation, production proposal creation, external checkpoint transition, or production dispatch occurred. The next decision point is after independent trust provisioning and owner/provider evidence are available—not after another shadow-mode or test-local APPROVED result.

See [RC.17 detailed acceptance](goal-plan-execution-acceptance-rc17-20261028.md) for the end-to-end and negative-test evidence.
