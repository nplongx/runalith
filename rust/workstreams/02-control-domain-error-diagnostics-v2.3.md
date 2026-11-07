# WS2 Control Domain Error Diagnostics V2.3

**Status:** `DRAFT_NOT_RATIFIED`  
**Supersedes:** V2.2 fixture `1925639462ce31ab8c5883e2c1c98567e60283a66711b7179c308f2d3bf5238f`  
**Scope:** bounded source attribution and proposed Control-domain grouping for 29 exact cause codes.

## Contract

- `cause_code` is the exact, case-sensitive source `TrustError::code()` value. Preserve unchanged.
- `domain_code` is a separate proposed Control-domain category. It is not derived from or substituted for `cause_code`.
- WS8 transport must preserve both fields independently. Neither field aliases, flattens, or replaces the other; neither alone defines HTTP status or retry behavior.
- Verifier failures do not enable automatic retry. Ambiguous authority remains `UNKNOWN` / `UNRESOLVED`.
- A verified signed `Rejected` receipt is a domain decision, not authentication/transport failure, and does not authorize admission.

## V2.3 corrections

1. `origin_sources`, `propagated_through`, and `test_assertion_sites` are separate. Test assertions are not runtime origins.
2. ApprovalDecision inventory is partitioned exactly: 21 emitted codes exclusive to that inventory, 2 emitted overlaps (`AGG_APPROVAL_CLOCK_INVALID`, `AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID`), and 1 test-only overlap (`AGG_APPROVAL_SIGNATURE_INVALID`). ApprovalPolicy retains its separate nine-code inventory.
3. `AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID` has direct origins in `trust_config.rs` (lines 218–222 and 368–371) and a `TrustError::code()` mapping in `lib.rs`; distinct propagation sites remain separately recorded.
4. `AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE` is mapped by `lib.rs::TrustError::code()` and propagated through `trust_config.rs`.
5. `AGG_APPROVAL_SIGNATURE_INVALID` maps to `AUTHENTICATION_FAILED` only for `verify_input_signed_envelope_signature` phase.
6. `AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID` remains `REVIEW_REQUIRED`: its origins include structural, metadata-binding and expected-scope conditions, not only cryptographic verification.
7. `GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID` remains `REVIEW_REQUIRED` for closed authenticator DTO parsing and signature metadata binding. `GOVERNANCE_RECEIPT_SIGNATURE_INVALID` is host signer-output verification and remains `REVIEW_REQUIRED`, not caller authentication failure.
8. Host clock, signed timestamp parsing, host key/configuration, trust-root, trust snapshot, signature binding and digest/integrity cases remain conservatively `REVIEW_REQUIRED` where source phase does not justify a caller-domain attribution.

## Source pins

All hashes are SHA-256 of the WS6 source snapshots reviewed for this bounded inventory:

| Source | SHA-256 |
|---|---|
| `governance_receipt.rs` | `d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09` |
| `signed_envelope.rs` | `1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f` |
| `approval_decision.rs` | `c2a91acff103f58ac5746db520588c3308a0394437ebb75256dc1b4351969fc3` |
| `approval_policy.rs` | `13235b7af591435904c5f2ea7c981932fc90e87c585a4023e0ee23b14a839775` |
| `trust_ledger.rs` | `ffc6847c31c91cdfd65b5a8763762f6215a29f814cea05cefd572bfd9e008418` |
| `trust_config.rs` | `a86b6d1b82882522149188a87373c25e5e36f81b704faea8f1057f761b367d02` |
| `lib.rs` / `TrustError::code()` | `5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f` |

This is a bounded inventory across GovernanceReceipt, SignedEnvelope, ApprovalDecision, ApprovalPolicy, TrustError, TrustConfig and TrustLedger paths. It is **not** a complete inventory of `runalith-trust`.

## Reproducible validation

```bash
python3 -B -m json.tool rust/workstreams/02-control-domain-error-diagnostics-v2.3.fixtures.json >/dev/null
python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3-test.py
```

Expected validator result: all exact-code, origin/propagation separation, ApprovalDecision partition, ApprovalPolicy inventory, phase grouping, conservative review partition and source-hash pin assertions pass.

The validator is static fixture/source-hash validation. It checks explicitly modeled source/line/function facts against pinned source hashes; it does **not** dynamically parse Rust, prove source inventory completeness, execute verifier/runtime/API paths, prove cryptographic behavior, or establish Control transaction/transport behavior.

## Exact artifact hashes

- Fixture: `fb48d1cfceb53baa54765eff7a2de716130b9953f504189992973d654ff98750`
- Validator: `df3f18b2a81be18e35272e355cfa3bea14417ccd4870ab3ce017490da2e72008`
- This document: compute after final write.

**Disposition:** draft only; independent WS1/WS6 review pending; not ratified; no production release claim.
