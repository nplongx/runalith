# Adaptive Goal Graph production trust provisioning runbook

**Status as of 2026-10-26: prerequisites only; production trust is not provisioned or verified in the recorded current host.** This runbook describes the trust contracts implemented by the RC.11 candidate and the current rollout preflight. Earlier RC.8/RC.9/RC.10 references below preserve their historical gate observations; they are not the current candidate identity or activation decision. It must be executed by the relevant host/security authorities, not by a graph caller or workflow reviewer.

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
3. Once migration is confirmed by evidence, publish another incremented config with the old root revoked or outside its validity window. Verify a signed object from the revoked root fails closed. Keep the append-only trust history and change evidence.
4. For emergency revocation, the owning security authority must publish and provision a higher config version and confirm effective runtime state. Do not lower config versions or restore the local SQLite trust history from backup without comparing it to an independent monotonic checkpoint.
5. Independently verify that the two trust authorities have separate administrative control and private-key custody. Distinct strings in configuration alone do not establish organizational independence.

The local append-only SQLite ledger protects against ordinary configuration rollback while its state is intact; it cannot detect restoration of the entire ledger to an older copy. Production rollout additionally requires a host-managed `host-monotonic-trust-ledger-checkpoint/v1` verifier with an independently protected monotonic sequence/store and a cryptographically verified signed checkpoint. Its evidence must bind `authorityId`, `source`, `checkpointSequence`, `checkpointDigest`, `previousCheckpointDigest`, `ledgerStateSha256`, `trustDomainStateSha256`, exact `candidateSha256`, exact `rollbackSha256`, `signatureVerified`, `independentOfLocalLedger`, and canonical fresh `observedAt`. The checkpoint verifier—not an operator-authored JSON file or the local preflight—must establish signature validity, authority identity, chain continuity, anti-rollback monotonicity and independence.

**Important acceptance invariant:** `scripts/runalith-rollout.mjs` currently has no production-authority cryptographic checkpoint verifier or protected monotonic-store connector. `validateExternalAntiRollbackAnchorReport()` therefore performs structural/freshness/hash-binding checks for diagnostics only and always returns `verified: false`, even when a JSON report says `verified: true` and `signatureVerified: true`. Those booleans are caller assertions and must never be treated as cryptographic evidence. A positive production gate requires a host-owned verifier integration, authenticated response channel, and independent monotonic continuity proof; do not patch the report or mock the flags to clear this blocker. Historical RC.8/v18 and RC.9/RC.10 preflights reported `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED`; the published RC.11 acceptance record reports the same blocker remains open.

The repository now contains a protocol-level verifier/test contract at `scripts/lib/external-trust-checkpoint-contract.mjs`. It verifies Ed25519 signatures over canonical response bytes, binds a fresh request nonce and exact candidate/rollback hashes, checks freshness, and rejects sequence rollback or previous-digest discontinuity against a supplied continuity record. Its result deliberately includes `productionAuthorityEstablished: false`: this module cannot authenticate who provisioned the public key or prove that the continuity record came from an independent protected store. Test keys and continuity objects are disposable test doubles only. Do not wire a caller-selected key, JSON file, environment-supplied module path, local SQLite row, or test adapter into production rollout as the authority source.

To close the external-anchor blocker, the host/security authority must provision a host-owned adapter and public-key configuration outside the plugin's writable tree, protect their ownership and permissions, expose a challenge/response operation that binds the nonce and release hashes, and return signed current checkpoint state backed by an independently protected monotonic store. The adapter must authenticate its transport/source, enforce high-water sequence and previous-digest continuity remotely, and provide effective-config/adapter identity evidence. The host administrator must then independently verify the active runtime loaded that adapter and public root. Until those facts are observable and independently attested, preflight must keep `PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED` open.

## 5. Reconciliation and rollout gates

Trust provisioning alone does not authorize activation. Workflow owners must resolve each conflicting `EXECUTING` job/running task using host/provider identity and event → attempt → task → result/artifact lineage; absence of a lease is not proof that a worker is dead. No bulk reset, terminalization, retry or dispatch is permitted from the diagnostic report alone. The host operator must then collect a fresh read-only reconciliation and run preflight against the exact candidate and a rollback bundle whose bytes/version are understood:

```sh
node scripts/reconcile-active-workflows.mjs --limit 200 --out <new-unique-report.json>
node scripts/runalith-rollout.mjs verify-installed --candidate <candidate.mcpb>
node scripts/runalith-rollout.mjs preflight --candidate <candidate.mcpb> --rollback-bundle <rollback.mcpb>
```

Do not reuse an existing output path. Preflight exit code 3 means `BLOCKED`; preserve its machine-readable report and resolve each blocker with the authority that owns it. `CANDIDATE_VERSION_ALREADY_INSTALLED` is expected when the exact version is already installed; do not reinstall/restart identical bytes just to change generation identity. A genuine release change requires a new version and source-to-bundle evidence, plus verified rollback compatibility.

## 6. Acceptance boundary

Offline schema/pair validation proves only that the supplied documents satisfy the software contract and contain disjoint roots. It does not prove who controls the keys, that the files are deployed, that live evidence is truthful, that the external checkpoint is authentic, that workers are drained, or that production Goal → Plan → Execution Graph dispatch succeeded. Production readiness and live E2E remain unverified until independent evidence satisfies every corresponding gate.

## 7. RC.9/RC.10 reviewer-ledger hardening

The RC.9 successor rejects reviewer verification when the dedicated trust-ledger connection is absent, is in a transaction, or aliases the workflow database. RC.10 also makes the reviewer configuration-status diagnostic report `available: false` when anti-rollback ledger state is unavailable; a configured public key alone cannot make the status look ready. The runtime entry point opens `agg-trust-configuration.db` separately from `workflow.db`; unit and archive-extracted regressions assert that an absent/aliased ledger fails closed. This is a software invariant, not proof that the host's trust database is independently protected against whole-file restoration. The external monotonic checkpoint authority and cryptographic verifier remain required.
