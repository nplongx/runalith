# V2.3.2 live-source verification note

**Status:** `DRAFT_NOT_RATIFIED`; bounded source attribution only.

WS6's read-only review found that V2.3.1's “source hash pins” validator compares fixture strings to constants and regex-checks digest format; it does not read live Rust files. V2.3.1 is preserved unchanged and remains valid for its bounded inventory/fixture assertions, but its PASS must not be described as live-source verification.

V2.3.2 adds a separate live-file checker. It pins V2.3.1 fixture and validator bytes, reruns the unchanged V2.3.1 test, then computes SHA-256 from all seven live source paths. Captured results:

| Source | V2.3.1 snapshot SHA prefix | Current live SHA prefix | Result |
|---|---|---|---|
| `governance_receipt.rs` | `d5f682af…` | `d5f682af…` | MATCH |
| `signed_envelope.rs` | `1e7b638e…` | `1e7b638e…` | MATCH |
| `approval_decision.rs` | `c2a91ac…` | `1ef7e309…` | DRIFT |
| `approval_policy.rs` | `13235b7a…` | `13235b7a…` | MATCH |
| `trust_ledger.rs` | `ffc6847c…` | `ffc6847c…` | MATCH |
| `trust_config.rs` | `a86b6d1b…` | `a86b6d1b…` | MATCH |
| `lib.rs` (`TrustError::code`) | `5fba5f3c…` | `b980bd06…` | DRIFT |

Exact full hashes are recorded in `02-control-domain-error-diagnostics-v2.3.2-live-source.fixtures.json`.

Command:

`python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3.2-live-source-test.py`

Expected result: PASS immutable V2.3.1 fixture/validator pin, PASS V2.3.1 inventory validator, PASS all seven current live-file hashes, and explicit two-file DRIFT / five-file MATCH partition.

The two drifted paths must be treated as different source snapshots; V2.3.1 inventory remains pinned to its historical bytes. This check does not infer new cause codes, change the 29-code inventory, establish runtime behavior, cryptographic authority, trust authorization or `VERIFIED`. Any semantic source review requires exact owner diffs and a separate successor. No source file is modified by this validator.
