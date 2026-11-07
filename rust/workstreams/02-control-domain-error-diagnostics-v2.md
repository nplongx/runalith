# WS2 domain error diagnostics V2 — DRAFT

**Status:** DRAFT / NOT RATIFIED. This is a source-matched diagnostic vocabulary proposal, not runtime/API behavior or HTTP/retry policy.

| Artifact | SHA-256 |
|---|---|
| `02-control-domain-error-diagnostics-v2.fixtures.json` | `97a6b376514b1af67e191ba2612cfcea380a2e0741b3c59c33b42eb461a0900c` |
| `02-control-domain-error-diagnostics-v2-test.py` | `28325de4bfbdec821f7a960452ba8339fcdb7ecb764909b73415438db41ce44c` |
| WS6 `governance_receipt.rs` | `d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09` |
| WS6 `signed_envelope.rs` | `1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f` |
| WS6 `lib.rs` / `TrustError::code()` | `5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f` |

## 1. Exact cause-code correction

WS6 reviewed V1 and identified three shortened aliases. The exact source strings are:

- `GOVERNANCE_RECEIPT_PAYLOAD_MISMATCH`
- `GOVERNANCE_RECEIPT_DIGEST_MISMATCH`
- `GOVERNANCE_RECEIPT_TRUST_SNAPSHOT_MISMATCH`

The V1 fixture remains immutable historical evidence. V2 replaces those aliases and includes exact signature binding/digest mismatch, time/canonicalization/request errors, host clock and nonce availability, signed-envelope causes, revoked/expired trust, and the three `TrustError::code()` host crypto/database outcomes. Repeated source occurrences are represented as one unique code with multiple source paths.

V2 inventory contains **29 unique exact case-sensitive cause codes** scoped to current `governance_receipt.rs`, `signed_envelope.rs`, and `TrustError::code()` mappings. It does not claim to include every error in the entire trust crate.

## 2. Two-field error contract

- `domain_code`: WS2 producer-owned lifecycle/domain category.
- `cause_code`: exact WS6 source verifier/authority code, preserved byte-for-byte/case-for-case.
- W8 transport preserves them as two independent opaque fields. Do not rewrite either into the other, HTTP status, retry class or terminal guess.
- `AUTHORITY_UNAVAILABLE` keeps the exact cause and remains UNKNOWN/UNRESOLVED while authority/high-water is not established.
- Nonce same-ID/different-binding conflict is `IDEMPOTENCY_CONFLICT`, no automatic retry.
- Invalid signature/issuer is never flattened to `AUTHORITY_UNAVAILABLE`.
- A correctly verified signed `Rejected` is a domain decision, not authentication/transport failure; it never grants admission.

The coarse `domain_code` mappings in V2 are all explicitly `DRAFT_PROPOSED`; WS6 has confirmed the exact cause strings but has not ratified all WS2 domain groupings. WS8 has accepted transport preservation of two separate fields with blockers; it has not approved a runtime envelope schema, status or retry mapping.

## 3. Evidence

`python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2-test.py` passes:

1. exact 29-code source inventory and uniqueness (no shortened aliases);
2. independent `domain_code` / `cause_code` fields, with DRAFT mapping status;
3. authority unavailable retains precise cause/UNKNOWN/UNRESOLVED; nonce conflict is non-retryable;
4. verified `Rejected` remains a domain decision;
5. fixture pins exact WS6 source hashes.

This is source-string inventory/fixture validation only. No WS6 runtime verifier, Control API, Gateway schema, route or production authority was invoked.
