# Runalith release-evidence verifier (Phase A)

**Status:** local Ed25519 evidence contract implemented; GitHub hosted builder and independent-verifier workflow source also implemented but not yet observed running. Production release remains BLOCKED. Neither layer is a host-owned release authority.

## What is implemented

`scripts/lib/runalith-release-trust-contract.mjs` and `scripts/verify-release-evidence.mjs` implement a deliberately narrow, versioned profile for:

- A DSSE v1 envelope carrying an [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md).
- SLSA Provenance v1 bound to the exact candidate MCPB SHA-256, repository, commit, tree/snapshot digests, clean tracked/untracked source state, build type, invocation ID and builder identity.
- A separately signed candidate-verification statement bound to the same candidate digest, source snapshot, policy digest, entry-inventory digest and each required test's status/exit code.
- A separately signed release approval bound to the candidate, exact provenance-envelope bytes, exact verification-envelope bytes, policy digest/version, environment, baseline version/digest, rollback version/digest, validity interval and host-provided one-time nonce.
- Ed25519 signer checks, validity/revocation windows, strict JSON parsing (including duplicate-key rejection), exact security-critical field sets, digest checks and disjoint builder/verifier/release-authority identities and key roots.
- Stable descriptor reads for candidate, rollback, policy and evidence files in the CLI, including rejection of symlink aliases and detected file replacement during reads.
- In-process DSSE-envelope validation also canonicalizes caller-owned JavaScript objects through property descriptors before any envelope field is read. Accessors, hidden properties, decorated/sparse arrays, symbols, cycles and repeated object identities fail closed; this applies to direct library callers as well as the strict-JSON CLI path.

The standalone DSSE/SLSA verifier contract uses explicitly pinned Ed25519 keys in the supplied policy file. It does **not** itself implement Cosign certificate/issuer verification or transparency-log inclusion proof, a hosted controlled builder, or an authenticated host-policy provisioning proof. The rollout CLI separately contains an explicit opt-in host-owned checkpoint adapter bridge, but it is not configured on the current host and has not been exercised against a production monotonic store. Do not describe this repository as having completed production trust provisioning or rollout authorization.

The hosted build path is separate and described in [Runalith hosted builder pipeline](runalith-hosted-builder-pipeline.md). It uses GitHub/Sigstore attestation verification via `gh attestation verify`, then repeats the tests and build from the exact source commit in an independent workflow, requires the candidate MCPB bytes to match byte-for-byte, and signs a candidate-verification predicate from a separate verifier workflow. This is *implemented workflow source*, not observed acceptance: it has not yet been run on GitHub in this work session. The hosted pipeline does not use the local pinned-Ed25519 policy as a substitute for the GitHub identity, nor does the GitHub attestation substitute for independent release approval or host trust provisioning.

## Policy contract

The policy is strict JSON with exactly these top-level keys:

`schema_version`, `contract`, `policy_version`, `source_repository`, `subject_name`, `expected_build_type`, `target_environment`, `required_tests`, `max_approval_ttl_seconds`, `trusted_signers`.

Required constants and constraints:

- `schema_version: 1`, `contract: "runalith-release-policy/v1"`, positive integer `policy_version`.
- `source_repository` is the canonical expected HTTPS repository URI. `subject_name` is the fixed in-toto subject name for this package family. `expected_build_type` and `target_environment` are exact policy strings.
- `required_tests` is a non-empty, unique list of stable test identifiers. Every required test report must say `PASS`, have `exit_code: 0`, and bind the exact candidate SHA-256.
- `max_approval_ttl_seconds` is an integer from 1 to 86,400 seconds.
- `trusted_signers` is a list of entries containing exactly `key_id`, `role`, `identity`, `public_key_pem`, `not_before`, `not_after`, `revoked_at`. Roles are `builder`, `verifier` and `release_authority`; timestamps use canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, and nullable expiry/revocation is represented by JSON `null`.
- Each role must have a usable Ed25519 root. A key fingerprint or signer identity cannot be shared across roles. Use only roots issued and provisioned through the organization’s approved authority process; no production roots or example keys are embedded in this repository.

Policy validation is not proof that the policy file, public keys or identity strings were provisioned by an independent administrator. The verifier parses the exact raw policy bytes, rejects duplicate JSON keys, and requires the parsed policy to match the caller-supplied object before any signer or scope decision. All downstream decisions use the parsed byte-bound policy, and the signed release approval pins the SHA-256 of those exact bytes. Pairing a valid policy object with different policy bytes fails with `RELEASE_EVIDENCE_POLICY_BYTES_MISMATCH`; matching only the claimed digest is not sufficient.

The production rollout preflight adds a separate canonical-scope barrier before it opens caller-selectable DSSE evidence paths: `source_repository` must be `https://github.com/nplongx/runalith`, `subject_name` must be `runalith.mcpb`, `expected_build_type` must be `https://runalith.dev/build/mcpb/v1`, and `target_environment` must be `production`; `policy_version` must be a positive integer. A root-owned policy therefore cannot silently retarget the local release gate to another repository, package family, build type or lower-trust environment. This source/scope pin is an implementation guard, not an administrator-provisioning signature: the host administrator must still supply the actual policy through the approved change-control path and preserve its independently governed policy/source record. The local preflight records the observed policy SHA-256, owner and mode but does not manufacture that external approval.

The DSSE library entry point accepts in-memory objects for integration tests and trusted callers, so it does not assume every envelope originated from the CLI parser. Before checking `payloadType`, signatures or signer IDs, it performs descriptor-based canonicalization and reparses the result into inert strict JSON. This avoids invoking attacker-controlled getters during field access. Regression `direct DSSE verifier rejects hostile object envelopes without invoking accessors` protects this boundary. It remains a local input-safety property, not proof of signature authority or host trust provisioning.

## Attestation profile

Each DSSE envelope must have the `application/vnd.in-toto+json` payload type and a single in-toto Statement subject whose `name` equals the policy's `subject_name` and whose `digest.sha256` equals the exact file bytes hashed by the verifier. Each signature uses DSSE v1 PAE and a policy-listed Ed25519 signer.

The SLSA profile requires `predicateType: "https://slsa.dev/provenance/v1"`. For predictable verification, the accepted `buildDefinition` and `runDetails` fields are intentionally constrained by the implementation. The source object must include the canonical repository, immutable commit, SHA-256 tree and snapshot digests, `working_tree_clean: true`, and the SHA-256 of empty tracked-diff and full-worktree-status bytes. `resolvedDependencies` must include the same repository and commit. The SLSA builder ID must equal the verified DSSE signer identity.

The verification report uses predicate type `https://runalith.dev/attestations/candidate-verification/v1`. The approval uses `https://runalith.dev/attestations/release-approval/v1`. Their exact fields are enforced in `scripts/lib/runalith-release-trust-contract.mjs`; unknown security-critical fields fail closed rather than being silently ignored.

The approval nonce must come from the host caller. This CLI checks equality but does not store consumed nonces, so anti-replay requires a host-owned nonce issuer/ledger. The current production checkpoint requirement remains separate and unsatisfied.

## CLI

Run with operator-issued inputs and newly created evidence paths (names below are illustrative only):

```sh
node scripts/verify-release-evidence.mjs \
  --candidate /secure/release/candidate.mcpb \
  --rollback /secure/release/rollback.mcpb \
  --policy /etc/runalith/release-policy.json \
  --provenance /secure/release/provenance.dsse.json \
  --verification /secure/release/candidate-verification.dsse.json \
  --approval /secure/release/release-approval.dsse.json \
  --expected-nonce <host-issued-one-time-hex-nonce> \
  --baseline-version <observed-installed-version> \
  --baseline-sha256 <observed-installed-sha256> \
  --rollback-version <rollback-version>
```

The verifier hashes candidate and rollback bytes itself. The installed baseline digest/version and the nonce are supplied observations; until they are authenticated by a host-owned integration, they do not establish production authority. Rollback must byte-match the exact baseline digest and version in this profile. The CLI does not install or activate anything and prints a machine-readable report to stdout only.

Exit codes: `0` is not used to mean production-ready by this tool; `2` means arguments, structure or cryptographic evidence are invalid; `3` means the cryptographic evidence chain verified but the production gate remains BLOCKED. The report sets `productionReleaseEligible`, `productionAuthorityEstablished`, `hostTrustContextAuthenticated` and `monotonicCheckpointAuthenticated` to `false` unconditionally.

Suggested checks:

```sh
node --test tests/test-runalith-release-trust-contract.mjs
npm run docs:check
git diff --check
```

## Remaining work before production eligibility

1. Run the protected-main hosted builder and independent-verifier workflows on the reviewed commit and retain actual workflow IDs, candidate SHA-256, SLSA attestation bundle, verified timestamp evidence, byte-identical independent-rebuild report, source alignment reports and signed candidate-verification predicate.
2. Review external branch-protection/ruleset and GitHub attestation settings independently. The verifier source is pinned to the `gh attestation verify` repository/workflow/source/issuer constraints, but the active GitHub repository's owner/settings must not be inferred from YAML alone.
3. Authenticate the effective host trust-policy provisioning and signer custody independently; do not infer it from a local file.
4. Integrate the host-owned external monotonic checkpoint adapter, one-time nonce consumption and authenticated continuity store.
5. Extend the existing read-only rollout preflight to consume only authenticated verifier outputs, and preserve all current workflow-drain, Plan-step evidence, inventory and rollback compatibility gates.
6. Complete the controlled-builder, independent-verifier, runtime receipt, installation, and tested rollback phases on a non-production host generation before any separate production authorization.

## Phase 2 custody evidence intake (local verifier)

`scripts/lib/phase2-custody-evidence.mjs` and `scripts/verify-phase2-custody-evidence.mjs` add a strict intake check for owner-supplied Phase 2 custody material. This does **not** reconstruct the historical 71-path list or mint a manifest/receipt. The authoritative manifest and builder receipt must be issued by their actual owners.

The v1 manifest is a signed JSON object with exactly `schema_version`, `contract`, `authority_id`, `repository`, `source_commit`, `source_tree_oid`, `issued_at`, `paths`, and `signature_base64`. It must use `runalith-phase2-authoritative-manifest/v1`; `paths` is exactly 71 sorted, unique, safe regular-file paths. The v1 builder receipt has exactly `schema_version`, `contract`, `builder_identity`, `repository`, `source_commit`, `source_tree_oid`, `source_snapshot_sha256`, `candidate_sha256`, `candidate_size_bytes`, `manifest_sha256`, `built_at`, `invocation_id`, and `signature_base64`; it uses `runalith-phase2-builder-receipt/v1`. Each signature covers canonical JSON of the object without `signature_base64`, using a distinct Ed25519 key. The receipt binds exact candidate bytes and raw manifest bytes.

The verifier also checks that the commit and tree resolve in the supplied local repository, that `source_snapshot_sha256` equals the deterministic `git archive --format=tar` digest for that commit, that the candidate inventory equals the signed manifest, that ZIP entries are regular files, and that each archive entry matches the pinned tree (with the existing canonical `package.json` projection rule). It reads evidence and candidate via stable non-symlink descriptors and inspects a private copy of the exact candidate bytes whose digest is checked.

Example, using *owner-issued* public keys and independently delivered expected SPKI fingerprints (placeholders below are not valid evidence):

```sh
node scripts/verify-phase2-custody-evidence.mjs \
  --repository-root /path/to/source-checkout \
  --candidate /path/to/candidate.mcpb \
  --manifest /path/to/owner-signed-71-path-manifest.json \
  --receipt /path/to/builder-signed-receipt.json \
  --authority-public-key /path/to/owner-public-key.pem \
  --builder-public-key /path/to/builder-public-key.pem \
  --expected-authority-key-sha256 <independently-delivered-authority-spki-sha256> \
  --expected-builder-key-sha256 <independently-delivered-builder-spki-sha256> \
  --expected-authority-id <phase2-contract-owner-id> \
  --expected-builder-identity <controlled-builder-identity> \
  --expected-repository <canonical-https-repository-uri>
```

Exit code `2` means malformed, mismatched, or invalid evidence; exit code `3` means the supplied cryptographic/source bindings verify but authority is still **BLOCKED**. Even a successful report sets `trustRootProvisioningAuthenticated`, `builderIdentityIndependentlyAuthenticated`, and `productionAuthorityEstablished` to `false`. The CLI cannot prove that the expected key fingerprints came from an independent custody channel, cannot authenticate who controls the builder, and does not verify an external monotonic checkpoint. A local filesystem path, local manifest, valid signature, or hash recheck alone is not production dispatch authority.

Regression coverage: `npm run test:phase2-custody` exercises a positive synthetic 71-path source/build chain and negative cases for candidate mutation, root collision, pin mismatch, receipt tampering, and a non-71-path manifest. These tests validate the verifier contract only; they do not supply the missing historical Phase 2 owner evidence.

## Rollout preflight trust-policy integration

The rollout preflight now consumes the custody verifier rather than treating the 71-path gate as permanently unconditional. This is deliberately gated by a **host-provisioned** policy at `/etc/runalith/phase2-custody-trust.json`; the CLI does not accept trust roots or key fingerprints on its command line. The directory and policy file must be canonical, root-owned, and not group/world writable. A policy in the repository, `/tmp`, or an arbitrary caller-selected path is not accepted as production trust.

The policy is strict JSON with exactly these keys:

```json
{
  "schema_version": 1,
  "contract": "runalith-phase2-host-custody-policy/v1",
  "policy_version": 1,
  "updated_at": "<canonical-UTC-timestamp>",
  "updated_by": "<platform-security-administrator>",
  "change_reference": "<approved-change-or-ticket-id>",
  "authority_id": "<phase-2-contract-owner-id>",
  "builder_identity": "<controlled-builder-identity>",
  "repository": "https://github.com/nplongx/runalith",
  "source_commit": "<frozen-40-or-64-hex-commit>",
  "source_tree_oid": "<frozen-40-or-64-hex-tree-oid>",
  "authority_key_id": "<unique-key-id>",
  "authority_public_key_pem": "<owner-provisioned-Ed25519-public-key-PEM>",
  "authority_key_sha256": "<SPKI-DER-SHA256>",
  "authority_key_not_before": "<canonical-UTC-timestamp>",
  "authority_key_not_after": null,
  "authority_key_revoked_at": null,
  "builder_key_id": "<unique-key-id>",
  "builder_public_key_pem": "<builder-provisioned-Ed25519-public-key-PEM>",
  "builder_key_sha256": "<SPKI-DER-SHA256>",
  "builder_key_not_before": "<canonical-UTC-timestamp>",
  "builder_key_not_after": null,
  "builder_key_revoked_at": null
}
```

The manifest authority and builder must be different Ed25519 roots, and both fingerprints must match the supplied public keys. Both keys must be within their explicit validity windows and not revoked at verification time. A key rotation must increment `policy_version`, supply an approved `change_reference`, new `key_id`, public key and independently checked SPKI fingerprint; v1 custody manifests/receipts do not carry a key ID, so an overlap window is not accepted for one signed object. Revocation is fail-closed. The source repository is pinned to `https://github.com/nplongx/runalith`; `source_commit` and `source_tree_oid` must be fixed by the contract owner and must not be populated from an unreviewed local worktree. After the administrator provisions that policy and the respective owners provide the actual signed files, invoke preflight with both evidence files:

```sh
node scripts/runalith-rollout.mjs preflight \
  --candidate /path/to/candidate.mcpb \
  --rollback-bundle /path/to/verified-rollback.mcpb \
  --phase2-manifest /path/to/owner-signed-71-path.json \
  --phase2-receipt /path/to/builder-signed-receipt.json \
  --release-policy /etc/runalith/release-policy.json \
  --provenance /path/to/builder.dsse.json \
  --verification /path/to/verifier.dsse.json \
  --approval /path/to/release-approval.dsse.json \
  --release-nonce <host-issued-one-time-nonce>
```

The release policy has the same fixed host-provisioning boundary at `/etc/runalith/release-policy.json`. This prevents a caller from defining their own builder/verifier/release-authority public keys and then using self-signed evidence to clear the release-evidence gate. The signed provenance, candidate-verification statement and approval must still pass all digest, role, identity, environment, baseline/rollback and expiry checks.

## External monotonic checkpoint adapter (explicit opt-in)

The ordinary `preflight` command does **not** mutate the security ledger and leaves the external-anchor gate closed unless a verifier-created, candidate/rollback-bound report is attached. A platform operator may explicitly request one external checkpoint transition using `--advance-external-checkpoint`. This is not a dry-run: it consumes a one-time nonce and commits the next high-water sequence in the external store. The flag does not install/activate the MCPB or write the workflow database, but the overall command/report must be marked `readOnly: false` and record the external-store transition outcome.

The platform-security administrator must provision `/etc/runalith/external-checkpoint-trust.json` as a canonical, root-owned regular file under the root-owned, non-group/world-writable `/etc/runalith` directory. It is strict JSON with exactly these fields:

```json
{
  "schema_version": 1,
  "contract": "runalith-external-checkpoint-host-policy/v1",
  "policy_version": 1,
  "updated_at": "<canonical-UTC-timestamp>",
  "updated_by": "<platform-security-administrator>",
  "change_reference": "<approved-security-change-id>",
  "authority_id": "<checkpoint-authority-id>",
  "authority_key_id": "<checkpoint-signing-key-id>",
  "authority_public_key_pem": "<independently-provisioned-Ed25519-public-key-PEM>",
  "authority_key_sha256": "<SPKI-DER-SHA256>",
  "authority_key_not_before": "<canonical-UTC-timestamp>",
  "authority_key_not_after": null,
  "authority_key_revoked_at": null,
  "store_attestation_key_id": "<distinct-external-store-attestation-key-id>",
  "store_attestation_public_key_pem": "<separately-provisioned-Ed25519-public-key-PEM>",
  "store_attestation_key_sha256": "<SPKI-DER-SHA256>",
  "store_attestation_key_not_before": "<canonical-UTC-timestamp>",
  "store_attestation_key_not_after": null,
  "store_attestation_key_revoked_at": null,
  "adapter_path": "/usr/local/libexec/runalith/external-checkpoint-adapter",
  "adapter_sha256": "<SHA256-of-the-root-owned-adapter-executable>",
  "external_store_id": "<stable-independently-administered-store-id>",
  "external_service_uri": "https://<approved-external-security-service>/<path>",
  "max_store_attestation_age_seconds": 3600
}
```

The checkpoint response authority and the store-attestation signer must have different Ed25519 SPKI roots. Both roots have explicit validity/revocation metadata. The URI must be HTTPS to a non-local DNS host on port 443. The adapter executable and every parent directory must be canonical, root-owned, not group/world writable; its bytes must match the policy SHA-256. The adapter is a small host-owned integration, not code included in the MCPB. Its backing store must be independently administered, support atomic compare-and-swap of sequence/previous digest plus nonce consumption, and resist restoration of the plugin/workflow database. Local SQLite is not accepted for production continuity.

Protocol contract: the CLI sends one strict JSON record on stdin and reads one bounded strict JSON record on stdout, with no extra output. `observe` returns a `runalith-external-checkpoint-adapter-observation/v1` object containing the signed `host-monotonic-trust-ledger-checkpoint/v1` response, current `host_monotonic_store` high-water continuity, and a fresh store attestation signed by the distinct store-attestation key. The attestation's `evidence_sha256` must equal the canonical digest of the exact authority ID, store ID, service URI, continuity source, high-water sequence and previous checkpoint digest returned in that same observation; a valid signature over an unrelated evidence digest is rejected. Only after this attestation binding plus response signature/freshness/candidate/rollback/sequence/previous-digest verification passes does the CLI call `commit`, passing the expected prior sequence and digest, exact nonce and the proposed next checkpoint. The adapter must perform one external CAS transaction that atomically consumes the nonce and advances sequence/digest, then return a second authority-signed `runalith-external-checkpoint-commit-receipt/v1` with `commit_status: "COMMITTED"` and all fields bound to that exact transition. If the commit call fails or the receipt is invalid after the call may have reached the store, the CLI emits `UNKNOWN_AFTER_COMMIT_ATTEMPT`; operators must query the authoritative store by nonce before deciding whether to retry. They must not blindly issue another transition.

An explicitly authorized operator can invoke the transition with:

```sh
node scripts/runalith-rollout.mjs preflight \
  --candidate /path/to/candidate.mcpb \
  --rollback-bundle /path/to/exact-installed-baseline.mcpb \
  --advance-external-checkpoint \
  --report /path/to/new-preflight-report.json
```

The example omits other mandatory gates for brevity; a successful checkpoint transition alone never makes rollout ready. `--advance-external-checkpoint` must not be put in unattended/repeated smoke tests. Validate policy schema and key separation before use; provisioned host policy, the real adapter and external service must be reviewed and tested by the platform/security owner. No host policy or adapter is created by this repository, and this work session has not received an external signed checkpoint/store attestation or performed a live external transition. Until those exact inputs exist, the external-anchor blocker remains open.

These integrations make the gates consumable; they do not make missing owner inputs appear. If the administrator has not provisioned either host policy, the manifest/receipt are absent, the hosted workflow has not actually run, or policy keys/snapshots do not match, the corresponding gate remains blocked. The other production AGG trust configuration, external monotonic checkpoint and live workflow/task drain requirements remain independent gates. No local policy/test receipt or synthetic fixture establishes those host facts.

See also [the full provenance and release-trust design](runalith-provenance-release-trust-design.md) and [the production trust provisioning runbook](agg-production-trust-provisioning-runbook.md).
