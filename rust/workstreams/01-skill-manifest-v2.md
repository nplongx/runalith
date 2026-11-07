# WS1 — Portable skill-manifest V2 candidate

**Status:** DRAFT / planning evidence only; not ratified. Does not change the current four-field `SkillPinRefV1` or production Node importer.

## Ownership and compatibility

WS1 owns the compiler's immutable skill-pin structure and bundle digest included in `CompiledPlanV1`. WS6 owns trust decisions, signed resolution receipts, issuer/key/domain lifecycle and verification. WS8 owns eventual shared wire serialization. A content digest is not an authority receipt.

The existing Node profile in `src/runtime/workflow/agent-skills.js::bundleSkill` computes `SHA-256(UTF8(JSON.stringify([{path,sha256,size_bytes}, ...]))` after `localeCompare` sorting. It remains a legacy Node compatibility profile. Because collation is not pinned, W1 does not claim portable cross-runtime ordering for unrestricted Unicode paths. Do not silently reinterpret existing four-field pins or claim `Store.content_sha256` equals this bundle digest.

## Proposed portable profile

Profile ID: `urn:runalith:skill-manifest:v2-jcs-utf8-nfc-bytewise`.

1. Input is a finite set of eligible UTF-8 text files. This profile hashes that set; file enumeration, extension filters, hidden-directory exclusions and source acquisition are defined by the separately versioned importer policy below.
2. Paths are relative POSIX paths with `/`. Reject absolute/drive paths, backslash, NUL/control characters, empty segments, `.`/`..`, duplicate paths, ill-formed Unicode (including lone UTF-16 surrogates) and paths not already in NFC. Do not rewrite a source path during hashing. Logical identity is case-sensitive.
3. `sha256` is SHA-256 over exact UTF-8 file bytes. `size_bytes` is exact byte count, not character count.
4. Each record has exactly `{path, sha256, size_bytes}`. Sort records by unsigned lexicographic UTF-8 bytes of `path`.
5. Serialize the array with RFC 8785 JCS UTF-8 bytes. The Node candidate uses `JSON.stringify` over records constructed in exact `{path, sha256, size_bytes}` property order. This is byte-equivalent to JCS for this restricted schema because JCS orders the three fixed ASCII keys in that same UTF-16 lexical order, `path` is well-formed Unicode, `sha256` is lowercase ASCII hex, and `size_bytes` is a bounded non-negative safe integer whose ECMAScript JSON representation is the JCS number representation. This equivalence is limited to these record values; it is not a general-purpose JCS implementation. `bundle_sha256` is SHA-256 of those exact bytes.
6. Bounds candidate: at most 40 files, at most 32 KiB per file, at most 160 KiB total. Eligibility/filtering policy remains separately versioned and must be pinned before this profile can be treated as a complete importer contract.

Node-generated vectors and executable positive/negative checks are in `01-skill-manifest-v2.fixtures.json` and `01-skill-manifest-v2-test.mjs`. They cover path ordering across ASCII/NFC Unicode, case-sensitive names, exact file byte lengths, source-order replay, invalid paths, invalid UTF-16 content and filesystem case-alias handling. These are review fixtures, not production importer behavior or a Rust parity claim.

## Separately versioned importer selection policy

Candidate policy ID: `urn:runalith:skill-import:v2-text-tree-v1`. This ID must be included in any future trusted-skill plan pin as a separate field from `bundle_profile`; the manifest hash binds selected bytes, while the importer policy explains which source files are eligible.

- Enumerate recursively below one skill root, maximum depth 8. Include regular files only; never follow symlinks and reject a symlink encountered where an eligible file would otherwise be included.
- Eligible extensions, case-insensitively: `.md`, `.mdx`, `.txt`, `.json`, `.yaml`, `.yml`, `.toml`, `.csv`, `.xml`, `.html`, `.css`, `.svg`, `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.py`, `.sh`, `.sql`, `.graphql`.
- Skip any hidden path component (leading `.`) and directories `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `build`, `.next`.
- Require exact root entry `SKILL.md`. Its metadata `name` must be a valid skill slug and match the declared skill directory/name. Existing role-level limits are at most 8 skills; per skill at most 40 eligible files; each file at most 32 KiB; all files for one role at most 160 KiB.
- Reject malformed UTF-8, NUL-containing eligible text files and ill-formed UTF-16 strings. Never decode with replacement. These are explicit V2 successor semantics; legacy local importer currently skips NUL-containing files while its remote path rejects them, so do not claim V2 is behavior-identical to the current importer.
- GitHub acquisition must resolve the immutable commit and subtree tree before pinning. Reject truncated trees, symlink/gitlink or unsupported object modes in eligible paths, and any raw file whose exact bytes fail UTF-8/content checks. Mutable branch/tag names are not `skill_version` values.
- Local acquisition must start from a real directory, reject symlinked roots and descendants, use exact relative paths from the captured snapshot and verify file bytes/size from the same snapshot. The absolute local path is provenance only.
- Logical path identity remains case-sensitive. If the source filesystem is case-insensitive, the importer must prove the selected entries cannot alias. This candidate conservatively permits only ASCII paths on such filesystems and rejects case-fold collisions (for example `A.md` with `a.md`). Non-ASCII paths on case-insensitive filesystems remain fail-closed until an OS/filesystem-specific alias verifier exists. Do not case-fold or rewrite the logical paths in the manifest.
- Directory enumeration order is irrelevant; final manifest order is the profile's unsigned UTF-8 bytewise ordering.

The selection policy and manifest profile are distinct versioned inputs. A future plan pin must bind both IDs so a change in eligible-file rules cannot silently reinterpret the same source version.

## Immutable skill version proposal

Keep `skill_version` distinct from `bundle_sha256`:

- GitHub source: bind the resolved immutable Git commit OID and skill subtree tree OID (including object format); never use branch, tag, URL or directory path as version.
- Local source: bind a namespaced content-addressed complete-snapshot identity such as `local-content-snapshot:v1:sha256:<bundle_sha256>`. The absolute path is provenance only, not identity. A mutable directory is not an immutable revision until captured as a content snapshot.

This is a W1 proposal for review. A local snapshot receipt/owner authority is still needed before it becomes a trusted resolution.

## Candidate next-version pin

Keep the existing four-field `SkillPinRefV1` byte-for-byte and semantically unchanged. A future version may bind:

`role_id`, `role_version`, `skill_id`, `skill_version`, `bundle_profile`, `import_policy_profile`, `bundle_sha256`, `trust_snapshot_ref_sha256`, `authority_resolution_receipt_id`, `authority_resolution_receipt_sha256`.

Every field must enter the outer `CompiledPlanV1` digest. The full signed authority receipt must be retrievable and independently verified; the receipt digest alone is not authority. A `TrustSnapshotRef` alone does not prove high-water observation, currentness or revocation status. WS6's verifier must check exact skill/version/profile/bundle/role binding, issuer/audience/scope, snapshot high-water, current key validity/revocation, issue/expiry window and dedicated nonce replay before returning a verified resolution. An expired, stale, revoked or unobserved authority fails closed.

The compiled plan records historical, immutable provenance; it is not perpetual proof that a trust decision remains current. Admission-time policy/revalidation belongs to the authority and Control owners.

## W1 consumer requirements for the WS6 resolution receipt

The following is a **consumer-side field checklist**, not a WS1-owned DTO or a claim that WS6 has implemented it. The WS6 producer should publish the exact versioned schema and signed canonical bytes:

- Receipt identity and version: `schema_version`, `kind=trusted_skill_resolution`, `receipt_id`.
- Exact subject: `role_id`, `role_version`, `skill_id`, `skill_version`, `bundle_profile`, `bundle_sha256`.
- Authority identity: authenticated `issuer`, exact `audience`, dedicated `trust_domain` and `scope`, `key_id`, trust-root fingerprint.
- Trust snapshot: the complete `TrustSnapshotRefV1` identity or retrievable reference, including domain/provider/scope/config version/configuration fingerprint; the verifier separately proves explicit high-water observation and current key validity/revocation.
- Replay/time: dedicated nonce, `issued_at`, `expires_at`, and anti-rollback/config version.
- Integrity: canonical signed receipt bytes, declared signature algorithm, signature, and digest of the complete signed receipt. A payload digest or snapshot digest alone is not a signature.

The receipt must be retrievable by `receipt_id` and its complete bytes independently verifiable. W1's future plan pin references `receipt_id` plus `authority_resolution_receipt_sha256`; W1 does not store a trust table or issue/verify the signature itself. Missing receipt, wrong subject/audience, unavailable high-water, stale/revoked key, expiry, nonce conflict or digest mismatch fails closed.

## Open gates

- Project Owner must name/select any trusted-skill authority domain, issuer, scope and key custody. WS1 does not request a sixth domain or reuse an existing approval domain.
- WS6 must publish the exact receipt DTO/verifier contract and production authority decision; WS8 must review wire serialization.
- Independent Rust parity now matches both Node golden vectors byte-for-byte, including canonical byte length and bundle SHA-256. This is parity evidence for the constrained manifest-record profile and the supplied file sets only; it does not prove general JCS behavior, full path/NFC validation, importer enumeration, filesystem alias verification or production import.
- Accountable WS1 owner remains UNASSIGNED. This document does not authorize production trust, manifest importer changes, protocol edits or source schema migration.

## Validation

Run from repository root:

```sh
node rust/workstreams/01-skill-manifest-v2-test.mjs --write-fixture
node rust/workstreams/01-skill-manifest-v2-test.mjs
cargo test --manifest-path rust/Cargo.toml -p runalith-domain --test skill_manifest_v2_parity --locked --offline
```

The first command regenerates the Node-owned golden fixture from the checked-in vectors; the second verifies recorded canonical bytes, byte counts, digests and negative cases.
The Rust integration test independently derives file hashes, sorts records by unsigned UTF-8 path bytes, serializes the fixed ordered record shape, and compares exact bytes, byte counts and bundle digests against both Node-generated vectors. It also checks NUL and profile size/count bounds. It is a reference test, not a production importer or a general JCS implementation.
