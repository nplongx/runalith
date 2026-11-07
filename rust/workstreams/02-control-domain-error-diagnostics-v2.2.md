# WS2 domain error diagnostics V2.2 — DRAFT

**Status:** DRAFT / NOT RATIFIED. V2.2 is an immutable source-attribution and domain-grouping successor to V2.1. It does not define runtime/API behavior, HTTP/retry policy or production authority.

| Artifact/source | SHA-256 |
|---|---|
| `02-control-domain-error-diagnostics-v2.2.fixtures.json` | `1925639462ce31ab8c5883e2c1c98567e60283a66711b7179c308f2d3bf5238f` |
| `02-control-domain-error-diagnostics-v2.2-test.py` | `55f576823d822cd5ff5b77358ff72420475d16cf33a4d15a5db883db77c14d85` |
| WS6 `governance_receipt.rs` | `d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09` |
| WS6 `signed_envelope.rs` | `1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f` |
| WS6 `approval_decision.rs` | `c2a91acff103f58ac5746db520588c3308a0394437ebb75256dc1b4351969fc3` |
| WS6 `approval_policy.rs` | `13235b7af591435904c5f2ea7c981932fc90e87c585a4023e0ee23b14a839775` |
| WS6 `trust_ledger.rs` | `ffc6847c31c91cdfd65b5a8763762f6215a29f814cea05cefd572bfd9e008418` |
| WS6 `trust_config.rs` | `a86b6d1b82882522149188a87373c25e5e36f81b704faea8f1057f761b367d02` |
| WS6 `lib.rs` / `TrustError::code()` | `5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f` |

## 1. Source attribution model

V2.1 used a `sources` field that mixed direct emitters, propagation sites and test assertions. V2.2 replaces it with three independent fields:

- `origin_sources`: source paths/functions that directly emit the exact code or map an underlying error to it;
- `propagated_through`: callsites that may return an originating `TrustError` unchanged; never an origin merely because they propagate it;
- `test_assertion_sites`: test-only literals/assertions, never counted as emitted origins.

The code `AGG_APPROVAL_SIGNATURE_INVALID` is the explicit correction case: `signed_envelope.rs` emits it after Ed25519 verification failure. Literals in `governance_receipt.rs` and `approval_decision.rs` are test assertions, not emitter origins. Likewise, `AGG_TRUST_CONFIG_NOT_OBSERVED` and `AGG_TRUST_CONFIG_ROLLBACK` originate in `trust_ledger.rs`, and `AGG_TRUST_ROOT_REVOKED` / `AGG_TRUST_ROOT_OUTSIDE_VALIDITY` originate in `trust_config.rs`; receipt/envelope/policy/decision functions propagate those errors when their trust-observation/root lookup calls fail.

## 2. ApprovalDecision / ApprovalPolicy inventory partitions

V2.2 corrects the false V2.1 label that all 24 `approval_decision.rs` codes were ApprovalDecision-only/unmapped. Its exact partition is:

- **21 emitted ApprovalDecision codes** not in the mapped 29-code diagnostic set;
- **2 emitted overlap codes** already in the mapped set: `AGG_APPROVAL_CLOCK_INVALID` and `AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID`;
- **1 test-assertion-only overlap**: `AGG_APPROVAL_SIGNATURE_INVALID`, which is emitted by `signed_envelope.rs` and only asserted in `approval_decision.rs` / `governance_receipt.rs` tests.

`approval_policy.rs` is a separate direct emitter with 9 exact unique codes. Its overlap with ApprovalDecision is explicitly listed, as is its overlap with the mapped diagnostic set (`AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID`). The ApprovalPolicy source inventory is not automatically mapped to WS2 ControlFence domain semantics.

## 3. Domain-code review required where origin is not caller-attributable

WS6 identified that several V2.1 groupings could falsely blame caller input for host-side failures. V2.2 retains the precise `cause_code` but sets `domain_code=null`, `mapping_status=REVIEW_REQUIRED`, and `resolution=REVIEW_REQUIRED` for:

- host clock failures vs signed receipt/envelope timestamp failures;
- signer key/output mismatch and invalid signature returned by the host signer;
- canonicalization failure across builder/verifier phases;
- trust snapshot identity, signed payload, request/subject digest, signature binding or signed-envelope digest mismatch until phase/owner semantics are settled;
- expired/future-dated signed envelope windows;
- trust-root revocation/outside-validity;
- host OpenSSL/public-key configuration and trust-ledger infrastructure errors.

`operation_phases` records relevant phase context (e.g. `host_clock_at_signing` vs `signed_receipt_timestamp_parse`, `signer_output_verification` vs a separate verification input, host trust configuration vs caller payload). A single cause string is not sufficient to infer who supplied the faulty data. These rows remain unmapped pending WS6 / Project Owner review; they must not be flattened into `AUTHENTICATION_FAILED`, `MALFORMED_REQUEST` or `EVIDENCE_UNRESOLVED` by default.

V2.2 retains only previously clear provisional groupings as `DRAFT_PROPOSED`, including malformed approval request, exact receipt binding mismatch, nonce ledger unavailable, nonce conflict, explicit issuer/audience mismatch, trust high-water not observed, approval signed-envelope structural rejection and evidence nonce shape. All remain DRAFT; this is not WS6 approval.

## 4. Preserved two-field diagnostic boundary

- `domain_code`: WS2 lifecycle/domain category, if a reviewed mapping exists.
- `cause_code`: exact case-sensitive source code, unchanged.
- W8 must preserve these as two independent opaque values; neither becomes HTTP status, retry class, terminal guess or the other value.
- Nonce rebinding stays non-retryable `IDEMPOTENCY_CONFLICT`.
- Nonce authority unavailable stays `AUTHORITY_UNAVAILABLE` with exact `cause_code` and UNKNOWN.
- Verified signed `Rejected` stays a domain decision and never grants admission.

WS8 has accepted this separation for transport representation with blockers, not a runtime schema or route. The current `McpServiceErrorV1` is closed `{code,message}` and rejects `domain_code`/`cause_code`; W8 must decide a versioned typed response or route-specific producer payload before runtime preservation is proven.

## 5. Validator evidence and limits

Command: `python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.2-test.py`.

The validator checks:

1. exact 29 mapped case-sensitive cause strings;
2. origin / propagation / test-assertion separation and no overlap between origin and propagated arrays;
3. exact ApprovalDecision partition: 21 exclusive emitted + 2 emitted overlaps + 1 test-only overlap;
4. exact ApprovalPolicy 9-code origin inventory and source overlaps;
5. TrustLedger / TrustConfig / TrustError mapping origin corrections;
6. exact `REVIEW_REQUIRED` domain partition for host/authority/integrity cases;
7. preserved nonce conflict, signed `Rejected` and source hash pins.

This is source-attribution and fixture-structure evidence only. No Trust verifier runtime, Control API, Gateway route, production nonce ledger, signature proof, Control transaction, HTTP mapping or contract ratification was exercised.
