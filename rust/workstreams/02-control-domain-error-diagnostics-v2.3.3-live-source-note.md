# WS2 Control Domain Error Diagnostics V2.3.3 — Live Source / Crypto Error Classification

**Status:** `DRAFT_NOT_RATIFIED`  
**Machine fixture:** `02-control-domain-error-diagnostics-v2.3.3-live-source.fixtures.json`  
**Validator:** `02-control-domain-error-diagnostics-v2.3.3-live-source-test.py`  
**Purpose:** preserve V2.3.1/V2.3.2 as immutable historical snapshots; pin current seven-file WS6 Trust source snapshot and add exact line/function attribution for the WS6 crypto runtime-vs-invalid classification correction.

## 1. Predecessor disposition

- V2.3.1 remains the static 29-code inventory/partition. It does not open or hash live source files.
- V2.3.2 adds whole-file hashing for seven named Trust source files. Its immutable captured `governance_receipt.rs` hash is `d5f682...`; the current source is `7c51f6...`. The V2.3.2 checker correctly fails closed on that drift. Do not alter V2.3.1 or V2.3.2.
- V2.3.3 is the separately versioned current snapshot. It inherits the 29-code V2.3.1 classification without silently revising domain-code decisions, pins all seven current source files, and provides a bounded exact line/function map for the changed crypto classification path.

## 2. Current source snapshot

| Source | Current SHA-256 | Changed since V2.3.2 |
|---|---|---|
| `governance_receipt.rs` | `7c51f6bde7e376206abd51113c65e6c72525043b18e288dae87069a792af0096` | yes |
| `signed_envelope.rs` | `aa836df246e27809e806e600fbb5dfd8fd0d8ba3728e605ba4d56ea5e38cc1f1` | yes |
| `approval_decision.rs` | `1ef7e3095f431a81e20d10e3a9974e38d860ef3d1c0e03692645113011e8181a` | no |
| `approval_policy.rs` | `13235b7af591435904c5f2ea7c981932fc90e87c585a4023e0ee23b14a839775` | no |
| `trust_ledger.rs` | `ffc6847c31c91cdfd65b5a8763762f6215a29f814cea05cefd572bfd9e008418` | no |
| `trust_config.rs` | `a86b6d1b82882522149188a87373c25e5e36f81b704faea8f1057f761b367d02` | no |
| `lib.rs` | `0b8f3bcf949e3f3eaa804aae6ccd9a3b45e60e2467cdbb48a9060c413f51218f` | yes |

All seven hashes were independently recomputed at fixture creation and again by the V2.3.3 validator. The three changed paths are WS6-owned candidate source; WS2 did not modify them.

## 3. Exact WS6 crypto classification origin

WS6 fixed two paths that formerly collapsed every `verify_base64` error into a signature-invalid result. The shared helper now differentiates runtime inability from malformed input:

| `TrustCryptoError` | Returned cause | Meaning |
|---|---|---|
| `OpenSslUnavailable` | `AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE` | OpenSSL executable missing/unavailable |
| `UntrustedOpenSslBinary` | `AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE` | OpenSSL executable fails trust checks |
| `TemporaryFile` | `AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE` | verifier could not create/write its private temp file |
| `OpenSslOperation` | `AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE` | OpenSSL operation/process could not complete |
| `InvalidBase64`, `InvalidPublicKey`, `InputLimit` | caller's existing invalid code | malformed signature/key/input profile remains invalid evidence |
| validly encoded signature returning `Ok(false)` | caller's explicit signature-invalid branch | cryptographic verification completed and signature is false |

Exact sites:

- `signed_envelope.rs::map_signature_verification_error`, lines 21–35: shared classification helper; no new public cause code.
- `signed_envelope.rs::verify_signed_envelope`, lines 200–215: caller-supplied signature verification uses `AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID` for malformed input and `AGG_APPROVAL_SIGNATURE_INVALID` for `Ok(false)`.
- `governance_receipt.rs::build_governance_receipt_authenticator_v1`, lines 231–245: signer-output self-verification uses `GOVERNANCE_RECEIPT_SIGNATURE_INVALID` for malformed signature output or `Ok(false)`, while runtime errors map to unavailable.
- `lib.rs::TrustError::code`, lines 96–107: generic stable projection retains `AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE` for infrastructure variants, public-key-invalid for other crypto variants, and ledger-unavailable for SQLite errors.

Test sites:

- `signed_envelope.rs::signature_verification_runtime_errors_are_unavailable_not_invalid_envelopes`, lines 270–298: four infrastructure variants map to unavailable; InvalidBase64/InvalidPublicKey/InputLimit retain invalid envelope code.
- `governance_receipt.rs::signer_port_builder_reproduces_node_envelope_and_rejects_bad_signatures`, lines 931–980: valid fixture signer reproduces the expected envelope; an invalid signature remains `GOVERNANCE_RECEIPT_SIGNATURE_INVALID`.
- `lib.rs::trust_error_codes_keep_crypto_runtime_faults_out_of_invalid_public_key`, lines 300–345: generic `TrustError::code()` mapping cases.

The machine fixture also records the current line/function identities for these five cause-code origins: `AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE`, `AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID`, `AGG_APPROVAL_SIGNATURE_INVALID`, `GOVERNANCE_RECEIPT_SIGNATURE_INVALID`, and `AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID`. Test assertion sites remain explicitly distinct from emitter/mapping sites.

## 4. Validation

From the repository root:

```sh
python3 -m json.tool rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source.fixtures.json >/dev/null
python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source-test.py
```

Observed PASS:

- exact immutable V2.3.1/V2.3.2 predecessor fixture/checker/note pins;
- V2.3.1 static 29-code inventory validator;
- V2.3.2 predecessor checker still fails closed on its known first live mismatch in `governance_receipt.rs`;
- all seven current source hashes and exact three-file V2.3.2-to-V2.3.3 delta;
- seven line/function span anchors and five bounded cause-code line-origin entries;
- no new cause code and distinct runtime/malformed/false-signature classes.

Current WS6 candidate package verification, run by WS2 against the current shared checkout:

```sh
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-trust --locked --offline --jobs 1 -- --test-threads=1
cargo fmt -p runalith-trust -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy -p runalith-trust --all-targets --locked --offline --jobs 1 -- -D warnings
```

Observed: **90/90 tests PASS**, fmt PASS, all-target Clippy `-D warnings` PASS. This is local test evidence for WS6 candidate code; it does not provision a production signer, trust root, nonce service, issuer or verifier.

## 5. Review and limits

WS6 requested a separately versioned successor and explicitly instructed that V2.3.1/V2.3.2 remain unchanged. WS2 has created this bounded V2.3.3 inventory and will request WS6/WS1 review of the exact fixture/hash.

This is not a full dynamic inventory of every `runalith-trust` error path. The inherited 29-code domain mapping remains exactly as V2.3.1; V2.3.3 adds a focused line-level source map for the newly changed crypto classification. No API DTO, JSON schema, cause-code vocabulary, nonce persistence, trust domain, issuer, key policy or database semantics are changed by this W2 documentation/fixture work.

**Disposition:** `SOURCE_PINS_AND_BOUNDED_LINE_MAP_VERIFIED / DRAFT_NOT_RATIFIED`. No production source, schema, SQL, manifest, ACL, credential or deployment changed.
