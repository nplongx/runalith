# Adaptive Goal Graph production trust provisioning runbook

**Status as of 2026-10-27: prerequisites only; production trust is not provisioned or verified in the recorded current host.** This runbook describes the trust contracts implemented by the RC.11 candidate and the current rollout preflight. Earlier RC.8/RC.9/RC.10 references below preserve their historical gate observations; they are not the current candidate identity or activation decision. It must be executed by the relevant host/security authorities, not by a graph caller or workflow reviewer.

## 1. Authority and key custody

Two independently administered authorities are required:

| Trust domain | Environment variable | Domain / exact scope | Authority responsibility |
|---|---|---|---|
| Goal/Idea claim verifier | `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` | `goal_idea_verifier` / `agg.goal_idea_graph.verify` | Establish source provenance and verify supporting evidence/claims |
| Action-intent reviewer | `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` | `action_intent_reviewer` / `agg.action_intent.review` | Establish reviewer identity and authorize action intent |

Each environment variable contains the JSON document itself (not a path). The offline validator accepts a path to a provisioned JSON file. The host/security authority must retain private signing keys outside Runalith; Runalith receives public-key PEMs only. Do not use the same provider ID or the same mathematical Ed25519 public key in both domains. Separation is checked using canonical SPKI fingerprints, not PEM text hashes.

## 2. JSON contract (schema version 1)

Each administrator-created document must contain exactly these top-level fields:

```json
{
  "schema_version": 1,
  "domain": "goal_idea_verifier",
  "provider_id": "<authority-assigned-provider-id>",
  "config_version": 1,
  "updated_at": "<canonical UTC ISO-8601 timestamp ending in Z>",
  "updated_by": "<auditable administrator identity>",
  "change_reference": "<approved change/ticket reference>",
  "keys": [
    {
      "key_id": "<unique-lowercase-key-id>",
      "public_key_pem": "<authority-issued Ed25519 PUBLIC KEY PEM>",
      "scopes": ["agg.goal_idea_graph.verify"],
      "not_before": "<canonical UTC ISO-8601 timestamp ending in Z>",
      "not_after": null,
      "revoked_at": null
    }
  ]
}
```

The reviewer document must use domain `action_intent_reviewer` and scope `agg.action_intent.review`. The values in angle brackets are instructions, **not deployable values**. Do not generate placeholder roots or use test-local keys. Each key entry must contain exactly the six shown fields; key IDs and canonical public roots must be unique within the file; scope must be exactly the domain's single allowed scope; timestamps must be canonical UTC; `not_after`, when non-null, must be later than `not_before`. Revocation is represented by a non-null canonical `revoked_at`; a revoked root is rejected immediately. Config versions are positive monotonically increasing integers, recorded in the append-only trust history. Never lower a version or restore an older trust-ledger snapshot.

## 3. Offline validation before host provisioning

Store the two authority-supplied files in an administrator-controlled directory with restrictive permissions and canonical non-symlink paths. Validate both as a pair (the example paths are placeholders):

```sh
node scripts/validate-agg-trust-config.mjs \
  --domain goal_idea_verifier \
  --config /secure/admin-input/goal-idea-verifier.json \
  --peer-config /secure/admin-input/action-intent-reviewer.json \
  --require-peer-config
```

Expected success is `result: PASS` and `pairVerification.status: PAIR_SEPARATION_VERIFIED`, with distinct provider IDs and disjoint canonical public roots. Exit code 2 means malformed/unreadable input or a contract violation; exit code 3 means blocked (for example, a required peer file is missing or no usable root exists). A one-file check without `--require-peer-config` is retained for compatibility but is **not** proof of production pair separation. Validation prints file hashes/status, not the public-key documents, and does not edit the supplied files or host configuration.

After offline validation, the host administrator must provision the exact JSON contents into the two named environment variables of the host-managed plugin process, preserve the change record and effective configuration fingerprint, and verify the actual running process environment through the read-only rollout inspection. Do not infer effective configuration from a file on disk, shell environment, or successful offline validation.

## 4. Rotation, revocation and anti-rollback

1. Open an approved change record identifying the authority, affected domain, old/new key IDs, effective time and reason.
2. For overlap rotation, add the new public root while the old root remains valid; increment `config_version`. Verify new signatures are issued by the intended authority, then provision and inspect the effective runtime configuration.
3. Once migration is confirmed by evidence, publish the *next consecutive* `config_version` with the old root revoked or outside its validity window. The runtime ledger now rejects skipped versions (`AGG_TRUST_CONFIG_VERSION_GAP`) as well as rollback, same-version replacement, and timestamp rollback; a version gap could otherwise hide an unobserved key revocation. Verify a signed object from the revoked root fails closed. Keep the append-only trust history and change evidence.
4. For emergency revocation, the owning security authority must publish and provision a higher config version and confirm effective runtime state. Do not lower config versions or restore the local SQLite trust history from backup without comparing it to an independent monotonic checkpoint.
5. Independently verify that the two trust authorities have separate administrative control and private-key custody. Distinct strings in configuration alone do not establish organizational independence.

The local append-only SQLite ledger protects against ordinary configuration rollback while its state is intact; it cannot detect restoration of the entire ledger to an older copy. Production rollout additionally requires a host-managed `host-monotonic-trust-ledger-checkpoint/v1` verifier with an independently protected monotonic sequence/store and a cryptographically verified signed checkpoint. Its evidence must bind `authorityId`, `source`, `checkpointSequence`, `checkpointDigest`, `previousCheckpointDigest`, `ledgerStateSha256`, `trustDomainStateSha256`, exact `candidateSha256`, exact `rollbackSha256`, `signatureVerified`, `independentOfLocalLedger`, and canonical fresh `observedAt`. The checkpoint verifier—not an operator-authored JSON file or the local preflight—must establish signature validity, authority identity, chain continuity, anti-rollback monotonicity and independence.

**Important acceptance invariant:** `scripts/runalith-rollout.mjs` currently has no production-authority cryptographic checkpoint verifier or protected monotonic-store connector. `validateExternalAntiRollbackAnchorReport()` therefore performs structural/freshness/hash-binding checks for diagnostics only and always returns `verified: false`, even when a JSON report says `verified: true` and `signatureVerified: true`. Those booleans are caller assertions and must never be treated as cryptographic evidence. A positive production gate requires a host-owned verifier integration, authenticated response channel, and independent monotonic continuity proof; do not patch the report or mock the flags to clear this blocker. Historical RC.8/v18 and RC.9/RC.10 preflights reported `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`; the published RC.11 acceptance record reports the same blocker remains open.

The repository now contains a protocol-level verifier/test contract at `scripts/lib/external-trust-checkpoint-contract.mjs`. It verifies Ed25519 signatures over canonical response bytes, binds a fresh request nonce and exact candidate/rollback hashes, checks freshness, enforces the exact version-1 response field set, recomputes the declared checkpoint digest, and rejects replay, sequence rollback, skipped sequences, missing initial continuity, or previous-digest discontinuity against a supplied continuity record. The stable `checkpoint_digest` is SHA-256 of canonical JSON containing exactly `schema_version`, `contract`, `authority_id`, `checkpoint_sequence`, `previous_checkpoint_digest`, `ledger_state_sha256`, `trust_domain_state_sha256`, `candidate_sha256`, and `rollback_sha256`; the response signature covers the entire response including challenge nonce, timestamp, digest, and release binding. A continuity record must already be anchored at sequence 1 or higher; unanchored sequence-zero bootstrap is rejected. These checks reduce protocol ambiguity but do not authenticate the adapter or provisioner.

The verifier result deliberately includes `continuitySourceAuthenticated: false`, `authorityKeyProvisioningAuthenticated: false`, and `productionAuthorityEstablished: false`: this module cannot authenticate who provisioned the public key or prove that the continuity record came from an independent protected store. The freshness window is constrained to a positive safe-integer age of at most five minutes; invalid caller-supplied clocks/windows fail closed instead of widening the protocol. Test keys and continuity objects are disposable test doubles only. Do not wire a caller-selected key, JSON file, environment-supplied module path, local SQLite row, or test adapter into production rollout as the authority source.

To close the external-anchor blocker, the host/security authority must provision a host-owned adapter and public-key configuration outside the plugin's writable tree, protect their ownership and permissions, expose a challenge/response operation that binds the nonce and release hashes, and return signed current checkpoint state backed by an independently protected monotonic store. The adapter must authenticate its transport/source, enforce high-water sequence and previous-digest continuity remotely, and provide effective-config/adapter identity evidence. The host administrator must then independently verify the active runtime loaded that adapter and public root. Until those facts are observable and independently attested, preflight must keep `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` open.

## 5. Reconciliation and rollout gates

Trust provisioning alone does not authorize activation. Workflow owners must resolve each conflicting `EXECUTING` job/running task using host/provider identity and event → attempt → task → result/artifact lineage; absence of a lease is not proof that a worker is dead. No bulk reset, terminalization, retry or dispatch is permitted from the diagnostic report alone. The read-only reconciliation now inventories Goal/Idea Graph node/revision/membership/edge integrity, recomputes each current canonical snapshot hash, reports attestation durable-identity and freshness bindings without claiming signature validity, re-resolves bounded planner evidence references against current artifact/result/attempt/completion lineage or repository-local content-addressed source bytes, compares persisted planner graph snapshots with immutable source revisions, and inspects Plan Graph/Execution Graph proposal payloads nested in workflow events. Fingerprint consistency and a structurally clean graph/hash match do not prove trusted signatures, claim truth, independence, approval, immutable-plan pinning or dispatch authority. The host operator must collect a fresh read-only reconciliation and run preflight against the exact candidate and a rollback bundle whose bytes/version are understood:

```sh
node scripts/reconcile-active-workflows.mjs --db "$HOME/.chat-on-steroids/agent-orchestrator/workflow.db" --limit 200 --out <new-unique-report.json>
node scripts/runalith-rollout.mjs verify-installed --candidate <candidate.mcpb>
node scripts/runalith-rollout.mjs preflight --candidate <candidate.mcpb> --rollback-bundle <rollback.mcpb>
```

For a machine-readable, non-overwriting report saved outside the repository, add `--report /path/to/a/new-unique-report.json`. The parent directory must already exist and be canonical (not a symlink); an existing destination is rejected. On success the CLI prints the report path, SHA-256, size, decision and blockers, while the report file contains the complete detailed observation. Unknown command options now fail closed—use `--report`, not `--out`, for preflight evidence. Exit code `3` is an expected blocked decision, not a command crash.

Do not reuse an existing output path. The reconciliation opens SQLite with a read-only connection, writes only a new diagnostic report if `--out` is used, and refuses symlink aliases or an existing report destination. Review per-record job/task classifications plus `adaptiveGoalGraph.findings`, `goals[].attestations[]`, `plannerRuns[].graphFindings`, `plannerRuns[].evidence[].blockers`, `proposalFindings` and `proposalRecords`. Do not include operational reports in commits or release artifacts. The current workflow schema does not persist authoritative owner/provider IDs for all tasks. An absent process PID, provider run/session ID, lease, event, or completion result is an unresolved observation—not proof of worker death. Re-query exact records with responsible workflow owners and host/provider/runtime operators; require the exact task attempt, matching lease/owner epoch when available, result/artifact hashes, completion event, active provider execution status and an explicit approved lifecycle path before any action. Do not bulk-reset/terminalize jobs or tasks, release leases, retry, approve, dispatch or kill processes from this report. Preflight exit code 3 means `BLOCKED`; preserve its machine-readable report and resolve each blocker with the authority that owns it. `CANDIDATE_VERSION_ALREADY_INSTALLED` is expected when the exact version is already installed; do not reinstall/restart identical bytes just to change generation identity. A genuine release change requires a new version and source-to-bundle evidence, plus verified rollback compatibility.

The read-only observation on 2026-10-26 was consistent with a blocked rollout: 60 `EXECUTING` jobs, 61 running tasks and no `task_leases` rows; 15 Goal/Idea nodes/revisions, 16 edges and no stored verification attestations; 56 planner runs/373 evidence rows; one of 29 revalidated artifact evidence rows failed current durable-lineage checks; and six distinct pinned local-source references no longer matched their recorded content hashes. The event store contained 136 proposal requests, two Plan Graph proposal payloads and no observed Execution Graph proposal or candidate-created event. These are observations from that database at that time, not proof of current state or a substitute for the fresh checks above. Source/hash mismatches must remain invalid until new correctly produced evidence exists; never rewrite historical evidence or its expected hash to clear the blocker.

Each job/task reconciliation finding also carries a deterministic `findingId`, `code`, `severity: BLOCKER`, `status: UNRESOLVED`, `gate: HOLD`, exact source table names and record identifiers, a bounded observation summary, `authorizationGranted: false`, and a remediation instruction. The finding identifier binds those diagnostic fields only; it is not a signed finding, an immutable external record, proof of truth, or permission to execute the suggested remediation. A finding closes only after its owner re-queries authoritative records and records the required evidence through the approved lifecycle process. Keep these record-level reports in access-controlled operational storage and out of Git/release bundles unless an explicitly approved minimized extract is prepared.

## 6. Acceptance boundary

Offline schema/pair validation proves only that the supplied documents satisfy the software contract and contain disjoint roots. It does not prove who controls the keys, that the files are deployed, that live evidence is truthful, that the external checkpoint is authentic, that workers are drained, or that production Goal → Plan → Execution Graph dispatch succeeded. Production readiness and live E2E remain unverified until independent evidence satisfies every corresponding gate.

## 7. RC.9/RC.10 reviewer-ledger hardening

The RC.9 successor rejects reviewer verification when the dedicated trust-ledger connection is absent, is in a transaction, or aliases the workflow database. RC.10 also makes the reviewer configuration-status diagnostic report `available: false` when anti-rollback ledger state is unavailable; a configured public key alone cannot make the status look ready. The runtime entry point opens `agg-trust-configuration.db` separately from `workflow.db`; unit and archive-extracted regressions assert that an absent/aliased ledger fails closed. This is a software invariant, not proof that the host's trust database is independently protected against whole-file restoration. The external monotonic checkpoint authority and cryptographic verifier remain required.

## 8. Signed payload canonicalization and caller-object isolation

The RC.11 Goal/Idea verifier accepts an externally signed Ed25519 attestation only after strict canonicalization of its in-process input. The canonicalizer rejects accessors/non-enumerable properties, sparse or decorated arrays, symbols, forbidden `__proto__`, non-finite/non-JSON values, class/host objects, non-standard array prototypes, cycles and repeated object identities. It inspects property descriptors before reading values; `attest()` then reconstructs an inert JSON copy and uses that exact copy for field validation, signature verification and persistence. This prevents an accessor-backed caller object from running a getter while the verifier reads `goal_id` or other signed fields, and prevents different JavaScript object shapes from being silently collapsed to the same signed JSON bytes.

These checks establish one unambiguous representation for signature verification; they do **not** establish signer identity, organizational independence, claim truth or approval. The trust decision still depends on the configured provider ID, canonical SPKI fingerprint, key validity/revocation window, exact scope, current graph snapshot and resolved evidence manifest, nonce replay rejection, freshness, and the separately administered anti-rollback ledger. Regressions live in `tests/test-adaptive-goal-knowledge-verifier.mjs`; the active benchmark successor is now `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v40.json`. It preserves the v39 ground-truth oracle and adds source pins for the RC.12 versioned runtime plus the fail-closed signed release-evidence preflight; historical v39 and earlier fixture bytes remain unchanged. Never clear a trust blocker by editing a payload hash or using a test-local signing key as production authority.

## 9. Release-trust source inputs and current acceptance boundary (2026-10-27)

The current source-alignment verifier also hashes release-critical trust policy, verifier implementation, hosted workflow definitions, rollout implementation, their regression tests and operator documentation. These files can decide whether a bundle is releasable even though they are not MCPB archive entries. Changing one must change `sourceSnapshotSha256`; byte-identical MCPB payload alone is not enough. The report separately binds Git tracked diff and complete porcelain status, and rechecks the reported bundle path against the captured bytes at completion.

Current local candidate is tracked in the latest v38 acceptance section of `docs/goal-plan-execution-integration-followup-20261026.md`. All candidates remain test-only. Byte alignment is not authenticated builder provenance; the working tree is dirty and no authenticated build receipt or independent hosted verification is available. Fresh read-only preflight remains `BLOCKED` on all seven documented gates. Fresh reconciliation still observes two unattested Goal/Idea scopes, four source-reference mismatches, 22/22 Plan Graph steps missing supporting evidence, three unbound source snapshots, no Execution Graph proposal, and 60 jobs with running tasks but no active lease rows. No lease absence proves worker death.

Do not use RC.8 v17 or v18 as rollback for installed RC.11. v17 has 92 entries and 19 installed-file mismatches; v18 has 92 entries and 15 mismatches. The exact RC.11 source archive identified by the host registry has 93 entries and exact installed-generation parity, but is local-test-only and still requires independent release authorization. The active benchmark successor is `recovery-verifier-v40.json`; historical v39, v38, v37, v36 and earlier fixture bytes remain immutable.

## 10. Release-evidence enforcement at rollout preflight

The rollout gate now independently requires cryptographic verification of three exact-byte-bound evidence objects in addition to package inspection, rollback parity, effective runtime trust configuration, external checkpoint anchoring and workflow drain. Omitting the evidence arguments is an explicit `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED` blocker; passing a JSON object with `verified: true` or `cryptographicEvidenceVerified: true` is not accepted. The in-process result is accepted only when produced by the preflight's release-evidence verifier and bound to the exact candidate digest, rollback digest and installed baseline version.

The release authority must provision the policy and issue the one-time nonce out of band. Supply only its real signed DSSE artifacts; never generate a local signing key or synthesize approval to make this command pass:

```sh
node scripts/runalith-rollout.mjs preflight \
  --candidate <exact-candidate.mcpb> \
  --rollback-bundle <exact-installed-baseline.mcpb> \
  --release-policy /etc/runalith/release-policy.json \
  --provenance <independently-verified-builder-provenance.dsse.json> \
  --verification <independently-signed-candidate-verification.dsse.json> \
  --approval <separately-signed-release-approval.dsse.json> \
  --release-nonce <host-issued-single-use-lowercase-hex-nonce>
```

The local verifier validates DSSE/SLSA signatures, signer roles and separation, candidate/source/test bindings, approval expiry and nonce, plus exact installed-baseline/rollback digest bindings. Its result is still not host trust authority: the report must continue to show the effective verifier/reviewer config and external monotonic checkpoint gates as independently verified. Missing files, stale/replayed approvals, mismatched baseline/rollback or invalid signatures fail closed. The nonce must come from the host/release authority and must not be reused. Keep all operational evidence outside Git and do not pass production preflight output to any activation mechanism while its verdict is `BLOCKED`.

The policy path is not caller-selectable: the verifier requires `/etc/runalith/release-policy.json` to be a canonical, root-owned regular file, in a canonical root-owned `/etc/runalith` directory, not writable by group/other. A valid signature under a public key supplied in `/tmp`, the repository, or another caller-selected policy file must not open the release-evidence gate.

## 12. Frozen Phase 2 path authority is a separate rollout gate

Rollout preflight now consumes the Phase 2 custody verifier, but keeps `PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED` until the signed material also matches a host-provisioned policy at `/etc/runalith/phase2-custody-trust.json`. The policy pins the exact source commit/tree, authority and builder identities, and distinct Ed25519 SPKI fingerprints; the directory and policy file must be canonical, root-owned and not writable by group/other. The gate is intentionally not cleared by `archiveEntryCount === 71`, byte alignment, a caller-supplied public key, a locally signed manifest, the custody verifier's synthetic unit tests, or a self-asserted `verified` field. Current historical candidates with 92/93 entries cannot be trimmed or treated as canonical from the count alone.

**Owner/authority:** Phase 2 artifact-contract owner supplies the signed canonical 71-path manifest; controlled builder supplies the signed receipt for the exact candidate and canonical source commit/tree/snapshot; platform security independently provisions the authority and builder SPKI fingerprints and verifies their custody/rotation/revocation; host integration must consume those pinned identities and confirm the receipt's candidate digest, size, manifest digest, source tree and every archive path/byte. The builder and manifest authority roots must be disjoint.

**Acceptance predicate:** `verifyPhase2CustodyEvidence()` reports `CRYPTOGRAPHIC_AND_SOURCE_BINDINGS_VERIFIED`, the manifest contains exactly 71 sorted unique portable paths, archive inventory equals that path list exactly, all archived entries match the canonical Git tree (with only the documented generated `package.json` projection), receipt hashes bind the exact archive and manifest, and the host independently authenticates the key pins/builder identity. Only the host-owned result may close the rollout blocker; the local CLI intentionally reports production authority as unestablished and exits blocked even when submitted signatures verify.

**Closure/remediation:** the platform/security administrator must provision `/etc/runalith/phase2-custody-trust.json` with the exact schema documented in `docs/runalith-release-evidence-verifier.md`; the Phase 2 contract owner must issue the signed 71-path manifest; and the controlled builder must issue a receipt for the exact candidate/source tree. Preserve candidate, manifest, receipt, source commit/tree, public-key fingerprints and verifier output in restricted custody storage; independently confirm authority identity and rotation/revocation status; run the standalone `node scripts/verify-phase2-custody-evidence.mjs` for diagnosis, then rerun rollout preflight with `--phase2-manifest <owner-signed-manifest>` and `--phase2-receipt <builder-signed-receipt>`. The preflight verifies the actual signed files against the host-pinned policy. Any missing input, absent host policy, root collision, stale/revoked root, wrong candidate digest, tree mismatch, non-71 manifest or path/content mismatch leaves this blocker open. Do not create a successor candidate or final evidence index until these predicates and source-to-bundle alignment are proven.

## 13. External checkpoint nonce consumption

`verifyExternalTrustCheckpointResponse()` requires `commitCheckpointTransition`, not a nonce-only callback, before it can return `verified: true`. After signature, freshness, release-binding and continuity checks pass, the callback must atomically compare the expected authority, candidate and rollback binding, prior high-water sequence and checkpoint digest; reserve the request nonce; and advance to the next checkpoint sequence/digest. It returns exact boolean `true` only when the entire transition commits. A missing callback, stale compare-and-swap, reused nonce or failed transaction leaves a named blocker. The verifier separately reports `cryptographicResponseVerified`, `nonceConsumed` and `checkpointStateAdvanced`, so a valid signature cannot be mistaken for replay protection or durable advancement. `scripts/lib/sqlite-external-checkpoint-transition.mjs` implements the callback contract with one SQLite transaction and intentionally refuses to create/seed its schema or initial anchor. Disposable tests cover two independent connections and a reopen boundary in addition to exact replay and legacy nonce-only rejection.

This callback contract does not authenticate its own implementation. The SQLite tests prove the adapter's transactional behavior against a disposable local database, not independently protected custody, multi-host behavior, backup-restore resistance or production authority. A local `Set`, SQLite database or caller-provided callback cannot satisfy production anti-rollback requirements by itself.

The rollout CLI now has an **explicit opt-in** bridge for a host-owned external adapter. Ordinary preflight remains read-only and never invokes it. `--advance-external-checkpoint` sends one `observe` request, verifies the returned fresh signed checkpoint and store attestation, then sends one `commit` request only if signature, nonce, freshness, candidate/rollback binding and previous high-water continuity all verify. It records `readOnly=false`, the external transition outcome, `externalSecurityStoreMutationPerformed`, and distinguishes a commit ambiguity from a failure before commit. This command may mutate the independently managed external security store but does not install/activate a package or write the workflow database. Do not use the flag in repeated/automatic smoke tests.

**Host provisioning requirements:** `/etc/runalith/external-checkpoint-trust.json` must be a canonical root-owned policy file in the canonical root-owned `/etc/runalith` directory; group/other write bits are forbidden. It pins the checkpoint authority key and a **separate** store-attestation key, validity/revocation metadata for both, a stable external store ID/HTTPS endpoint, the SHA-256 of the root-owned executable `/usr/local/libexec/runalith/external-checkpoint-adapter`, and an approved change reference. The executable and every parent path component must be canonical/root-owned/non-group-or-world-writable. Both signing roots must be distinct. The external endpoint/store must be controlled independently of the plugin and workflow DB and resist restore/rollback of the local DB.

The adapter's `observe` response contract is `runalith-external-checkpoint-adapter-observation/v1`: it includes the signed `host-monotonic-trust-ledger-checkpoint/v1` response, a `host_monotonic_store` continuity record, and a fresh store attestation signed by the distinct store-attestation key. `commit` must atomically consume the exact request nonce and compare-and-swap the expected sequence/digest to the next sequence/digest in the external store. It must return the authority-signed `runalith-external-checkpoint-commit-receipt/v1` binding nonce, release digests, sequence, digest, previous digest and `COMMITTED` status. If a commit might have reached the store but no valid receipt is received, the report says `UNKNOWN_AFTER_COMMIT_ATTEMPT`; resolve the nonce against the authoritative service before another transition rather than blindly retrying.

An explicitly authorized operator can request the transition with `node scripts/runalith-rollout.mjs preflight --candidate <candidate.mcpb> --rollback-bundle <exact-baseline.mcpb> --advance-external-checkpoint --report <new-report.json>` plus the other evidence inputs required by rollout policy. The checkpoint transition alone does not make the candidate eligible: the independent release-evidence, Phase 2 custody, AGG trust-configuration and workflow/task-drain gates remain separate. This repository does not create the policy or adapter and no live external transition or signed production checkpoint has been received in this work session. Until real host provisioning, adapter hash/ownership inspection, distinct-key verification and fresh signed store/commit receipts are present, the external-anchor blocker remains open.

## 11. RC.12 integrated follow-up (2026-10-27)

The RC.11 baseline archive referenced by the host registry was read and inspected without changing the host. `artifacts/local-test-only/runalith-1.0.9-local-test-only-20261026.mcpb` is version `1.0.9-rc.11`, SHA-256 `ad32acca11708314a45e82616b5d31c2fda7ae3710ff2f5c764f8fb12b1163c3`, size 827,195 bytes, and its 93 file entries match the installed generation directory exactly. This closes the local rollback-parity/version checks when that exact baseline archive is used; it does not establish publisher provenance or independent release authorization. The older RC.8 v17/v18 archives remain incompatible with this baseline.

The test-only RC.12 successor is `/tmp/runalith-provenance-integrated-v40-20261027.mcpb`, SHA-256 `e106b8ba16762d2f280e06cb88e10faadb7063c5416bd0bd5db73bd93dfa9adb`, 836,984 bytes, 93 archive entries and 74 tools. It resolves the installed-version collision locally without installing or activating the candidate. The current read-only preflight is `/tmp/runalith-preflight-v40-final-20261027.json`, SHA-256 `e24c063595f6e37f60bf968f75f40e8b6e763cb9e62e40911e10f419e4dacea3`, generated `2026-10-27T07:21:44.348Z`, exit code 3. The RC.11 rollback archive passed smoke and exact 93/93 file parity. Five remaining decision blockers are `INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED`, `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`, `ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN`, and `RUNNING_TASKS_MUST_DRAIN`.

The current read-only reconciliation is `/tmp/runalith-reconcile-v40-20261027.json`, SHA-256 `d2164d36009be8ee2f7c358f86e741ff3ac23cb1df2f229e4fd53a7f6619e717`. It sees 60 jobs requiring owner reconciliation, 61 running tasks, zero lease rows, two unattested Goal/Idea scopes, four invalid current planner source references, three Plan Graph proposals with all 22 steps missing supporting evidence, and no Execution Graph proposal. The schema still lacks authoritative owner/provider identity for some records; the report's `HOLD_FOR_OWNER_RECONCILIATION` actions grant no authority. Follow the record-by-record procedure in §5 and retain every unresolved job/task unchanged.
