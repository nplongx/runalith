# WS2 Control Domain Error Diagnostics V2.3.1

**Status:** `DRAFT_NOT_RATIFIED`  
**Supersedes:** reviewed V2.3 draft fixture SHA `6a36601fdef914ed3d988b1bd86b8b2156349e2d38ac0ed9462f7d1299ce37a4`; V2.3 historical draft remains unchanged as a named version in the review record.  
**Scope:** bounded source attribution and proposed Control-domain grouping for 29 exact cause codes.

## V2.3.1 corrections

- Source-site path consistency: detailed `origin_sites[].path` for `lib.rs::TrustError::code()` occurrences now uses that exact qualified source identifier, matching `origin_sources`. Function and line attribution remain explicit.
- The expected `REVIEW_REQUIRED` partition includes `AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID`, because its direct configuration parse failures and lower-level crypto mapping do not justify caller authentication attribution.
- Preserves the V2.3 source/phase corrections: caller-supplied `AGG_APPROVAL_SIGNATURE_INVALID` maps to `AUTHENTICATION_FAILED` only in `verify_input_signed_envelope_signature`; mixed envelope causes and host signer-output failures remain `REVIEW_REQUIRED`.
- Preserves `origin_sources`, `propagated_through`, and `test_assertion_sites` as distinct categories; ApprovalDecision partition remains 21 exclusive emitted + 2 emitted overlaps + 1 test-only overlap; ApprovalPolicy inventory remains nine codes.

## Diagnostic contract

`cause_code` is the exact case-sensitive source code. `domain_code` is a separate proposed Control category. WS8 must carry both independently in a route-specific producer response payload; MCP service/transport `error` V1 remains closed `{code,message}` and is not extended or repurposed. Neither field defines HTTP/retry semantics. Automatic retry remains disabled for verifier failures. Unknown authority remains `UNKNOWN` / `UNRESOLVED`. A verified signed `Rejected` receipt is a domain decision and does not authorize admission.

## Source pins

| Source | SHA-256 |
|---|---|
| `governance_receipt.rs` | `d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09` |
| `signed_envelope.rs` | `1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f` |
| `approval_decision.rs` | `c2a91acff103f58ac5746db520588c3308a0394437ebb75256dc1b4351969fc3` |
| `approval_policy.rs` | `13235b7af591435904c5f2ea7c981932fc90e87c585a4023e0ee23b14a839775` |
| `trust_ledger.rs` | `ffc6847c31c91cdfd65b5a8763762f6215a29f814cea05cefd572bfd9e008418` |
| `trust_config.rs` | `a86b6d1b82882522149188a87373c25e5e36f81b704faea8f1057f761b367d02` |
| `lib.rs` / `TrustError::code()` | `5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f` |

This is a bounded source inventory, not a complete `runalith-trust` inventory.

## Reproduction

```bash
python3 -B -m json.tool rust/workstreams/02-control-domain-error-diagnostics-v2.3.1.fixtures.json >/dev/null
python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3.1-test.py
```

The validator checks explicit fixture facts and pinned source hashes. It does not dynamically parse Rust, prove source inventory completeness, execute verifier/runtime/API paths, prove cryptographic behavior, or establish Control transaction/transport behavior.

## Exact artifact hashes

- Fixture: `24e5d115604dfc066d25b056d27e9ef5cc7f4653477aced469d1ab8188e91832`
- Validator: `4abb6a47db775ed66f5e93022f37373adbf7715158acc789dd373c7fc294ee69`
- Document: calculate after this hash table is finalized.

**Disposition:** draft only; WS1/WS6 independent re-review requested; not ratified; no production release claim.
