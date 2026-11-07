# WS2 domain error diagnostics V2.1 — DRAFT

**Status:** DRAFT / NOT RATIFIED. V2.1 is an immutable source-attribution successor to diagnostics V2; no domain grouping, transport, HTTP, retry or production authority policy is ratified.

| Artifact | SHA-256 |
|---|---|
| `02-control-domain-error-diagnostics-v2.1.fixtures.json` | `2d0a783a136f03eace44180733d2690864b7428075db5b54cdf1105f4128fcfc` |
| `02-control-domain-error-diagnostics-v2.1-test.py` | `861083dded8b7a827bec3fea49ec2ab91f7eacb61eaa4821d749658b72142b32` |
| WS6 `governance_receipt.rs` | `d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09` |
| WS6 `signed_envelope.rs` | `1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f` |
| WS6 `approval_decision.rs` | `c2a91acff103f58ac5746db520588c3308a0394437ebb75256dc1b4351969fc3` |
| WS6 `lib.rs` / `TrustError::code()` | `5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f` |

## 1. Exact source attribution correction

WS1 independently reran diagnostics V2 and found `AGG_APPROVAL_SIGNATURE_INVALID` occurs in both `governance_receipt.rs` and `signed_envelope.rs`; V2 listed only one. V2.1 now lists all three observed occurrences: `governance_receipt.rs`, `signed_envelope.rs`, and `approval_decision.rs`. The overlapping `AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID` and `AGG_APPROVAL_CLOCK_INVALID` rows also record `approval_decision.rs` where the literal occurs there. No code spelling or domain mapping changed.

## 2. Separate ApprovalDecision source inventory

WS8 identified exact codes in `approval_decision.rs` outside the earlier GovernanceReceipt/SignedEnvelope source scope. V2.1 pins that source file and inventories all 24 unique exact literals. They are separately marked `SOURCE_INVENTORY_ONLY_NOT_MAPPED_TO_WS2_DOMAIN_CODE` because the ApprovalDecision pipeline is not assumed to be the ControlFence verifier diagnostic domain. No WS2 `domain_code`, HTTP status or retry meaning is invented for those codes. WS6/Project Owner must decide whether this source belongs in the Control diagnostic consumer surface.

## 3. Existing mapped diagnostic contract retained

The 29 unique mapped `cause_code` values retain exact source case and spelling. Three shortened aliases stay removed in favor of full `GOVERNANCE_RECEIPT_*` names. `domain_code` remains a separate WS2-owned category, all rows are `DRAFT_PROPOSED`, and WS8 preserves both values as independent opaque diagnostics. Authority unavailable stays UNKNOWN/UNRESOLVED; nonce rebinding stays non-retryable IDEMPOTENCY_CONFLICT; a verified signed `Rejected` receipt remains a domain decision and does not authorize admission.

## 4. Evidence and limits

Command `python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.1-test.py` validates the exact 29-code mapped source inventory, separate field layering, authority/nonce/signed-Rejected semantics, all four WS6 source hashes, source attribution for overlapping codes, and exact 24-code unmapped ApprovalDecision inventory. No runtime verifier, Control API, Gateway transport, HTTP route or production nonce service is exercised. Domain group mappings remain DRAFT; V2.1 does not ratify WS2 or WS8 contracts.
