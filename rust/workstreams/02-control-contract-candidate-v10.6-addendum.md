# WS2 Control contract candidate — V10.6 continuation addendum

**Status:** DRAFT / PROPOSED / NOT RATIFIED.  
**Lineage:** V9 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5` + V10 `9fb54a38f1f97f41af6d969d6ec06fc8a779beddcf9128ce0049ffb74375b9e8` + V10.1 `345179cbe3a1affca10f42b8fe5094df971afbed78179857ac6d41a99e01bf97` + V10.2 `ca6e310b5ccc79edd4eb455d7ded6dce3b034d0341c3dc842d4fd96e29cacabd` + V10.3 `d794a15cd5a30f72cf766772bb19e9fdb6f8fa266c8e22d2e64313aff3c4c16c` + V10.4 `504da2d0e33f870ad63c06353197de84cfc9d1683d67db1f220a4b95ec25201a` + V10.5 `3f4c828dd5dd5af13c66ceba9684139085000a563cd27defad6731cec9e46609` + this addendum. Earlier revisions remain immutable.

## 1. WS6 diagnostic-origin review and V2.2 successor

WS6 response `37cb3535-a0c3-4d4f-a362-6d6b6e4a24df` corrected V2.1 attribution and grouping. WS1 response `0e0b681d-7ae1-414b-b9ea-3987adf4ec99` independently found the ApprovalDecision overlap partition defect. WS2 accepted both and published immutable diagnostics V2.2.

| V2.2 artifact | SHA-256 |
|---|---|
| `02-control-domain-error-diagnostics-v2.2.md` | `42370e7a8cdd9db6dd9a7b25a828dd957ba5a2fe525edce62c10bd5197d815c3` |
| `02-control-domain-error-diagnostics-v2.2.fixtures.json` | `1925639462ce31ab8c5883e2c1c98567e60283a66711b7179c308f2d3bf5238f` |
| `02-control-domain-error-diagnostics-v2.2-test.py` | `55f576823d822cd5ff5b77358ff72420475d16cf33a4d15a5db883db77c14d85` |

Source attribution now distinguishes `origin_sources`, `propagated_through` and `test_assertion_sites`. It corrects:

- `AGG_APPROVAL_SIGNATURE_INVALID` originates in `signed_envelope.rs`; same literals in `governance_receipt.rs` and `approval_decision.rs` are test assertions only.
- `AGG_TRUST_CONFIG_NOT_OBSERVED` and `AGG_TRUST_CONFIG_ROLLBACK` originate in `trust_ledger.rs` and are propagated by receipt/envelope/approval call paths.
- `AGG_TRUST_ROOT_REVOKED` and `AGG_TRUST_ROOT_OUTSIDE_VALIDITY` originate in `trust_config.rs`; callers propagate them.
- ApprovalDecision partition: 21 emitted codes exclusive to that source inventory, 2 emitted overlap codes in mapped inventory (`AGG_APPROVAL_CLOCK_INVALID`, `AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID`), and 1 test-assertion-only overlap (`AGG_APPROVAL_SIGNATURE_INVALID`).
- ApprovalPolicy is separately pinned with 9 exact source-emitted codes and overlap with ApprovalDecision / mapped diagnostics.

WS6 source hashes pinned in V2.2: GovernanceReceipt `d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09`; SignedEnvelope `1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f`; ApprovalDecision `c2a91acff103f58ac5746db520588c3308a0394437ebb75256dc1b4351969fc3`; ApprovalPolicy `13235b7af591435904c5f2ea7c981932fc90e87c585a4023e0ee23b14a839775`; TrustLedger `ffc6847c31c91cdfd65b5a8763762f6215a29f814cea05cefd572bfd9e008418`; TrustConfig `a86b6d1b82882522149188a87373c25e5e36f81b704faea8f1057f761b367d02`; `TrustError::code()` lib `5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f`.

V2.2 validator PASS:

`python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.2-test.py`

It validates 29 exact mapped cause codes, source-origin/propagation/test partition, 21+2+1 ApprovalDecision partition, 9-code ApprovalPolicy inventory, trust-source origin corrections and domain REVIEW_REQUIRED partition. Four classes of earlier weak WS2 groupings (host clock/config, signer, canonicalization and integrity/subject-digest) now carry `domain_code=null`, `mapping_status=REVIEW_REQUIRED`; exact `cause_code` remains unchanged. This is source/fixture validation only, not runtime verifier or ratification.

## 2. WS6 authority remains NOT_ASSIGNED

WS6 response `4c6a8987-3c2c-47e1-a321-24a0acf7bd6c` states no Project Owner or Host Security/platform endpoint, named human owner, appointment artifact or decision exists in current directory. ControlFence issuer/audience/scope/key custodian, host ProcessStop signer, production nonce persistence owner remain unappointed. WS2 relayed this through the allowed WS2→WS6 edge; WS6 is also contacting WS7 through a permitted edge. No ACL is changed.

No ControlFence or ProcessStop production trust domain/key is selected. WS2 owns ControlFence producer/issuer/CAS; WS3 local process/cgroup facts remain diagnostic; WS4 owns provider terminal truth; Host Security/platform must appoint independent ProcessStop issuer/key custodian. Do not reuse GovernanceApprovalReceipt or execution_approval. No production receipt authentication, host ProcessStop attestation or cancellation settlement is proven.

## 3. WS8 transport representation is not yet runtime-capable in current MCP error V1

WS8 previously accepted the two-field `domain_code` / `cause_code` separation for transport representation only. WS2 then inspected the exact current WS8 code:

- Common Envelope V1 JSON schema SHA `ba01c0c9f973ace4d4b438307338fef1f18e45f99dba2929ddd33696cbee18b2`: generic `payload` object, no typed error fields.
- `McpServiceErrorV1` source SHA `1b7d7ed4090ad2d660150ae64d6bbc05f139954fb4258d4117b2cdb51758192c`: `deny_unknown_fields`, fields only `code` + `message`.

An external isolated Rust probe against W8 `runalith_protocol::mcp_service_v1::McpServiceErrorV1` was run offline. Legacy `{code,message}` deserialized; adding `domain_code` and `cause_code` failed with `unknown field domain_code, expected code or message`. Exit 0. No W8 source was edited.

WS2 sent W8 a review request under correlation `COS-A2A-WS2-WS8-MCP-SERVICE-DIAGNOSTICS-20261103`, message `dbc7ebd3-508e-4a1d-abe2-54c853833acd`, asking whether producer diagnostics belong in a route-specific typed payload or require versioned successor to MCP service error/response DTO. No reply yet. Until then, two-field preservation is accepted only at proposal/crosswalk level; current MCP error DTO runtime cannot carry both fields and must not be loosened in place.

## 4. Remaining convergence and release blockers

- WS3 V2.1 consumer: accepted with blockers for logical mapping only; 11/11 isolated consumer draft tests PASS. Active TaskClaim V3/Control HTTP V1 unchanged; no WorkerStore migration/journal or durable renewal journal.
- WS1 CommandRequest boundary: current typed Rust `CommandRequest` serialization accepted as a draft reference, but changes required before W1 compiled-task mapping. Current W1 task/role metadata is not an execution template; no executable/argv may be inferred from prompts or free-form metadata. Explicit local mode, command template/source, deterministic input-artifact -> argv/stdin mapping, PlanDigest binding, sandbox policy identity and CommandResult-to-artifact contract remain prerequisite.
- WS2 signed TaskClaim V4 bytes, signature algorithm/key/issuer/audience/freshness/revocation policy, duplicate-key rules and `CommandRequestV1` signed binding remain unresolved. V2.1 logical command vectors are not a signed corpus.
- Project Owner/Host Security must appoint accountable WS2, ControlFence issuer/key/nonce authority, separate ProcessStop signer and Control projection transaction/freshness owner; D-01 supersession remains blocked.
- No production signer/nonce authority, Control route, WorkerStore/Control Store schema or migration, DB split, production dispatch, cancellation settlement, deployment or cutover is authorized.

## 5. Overall disposition

WS2 logical vectors and consumer mapping are substantially improved and independently tested. WS3 accepts V2.1 for logical mapping; WS1 accepts only the typed CommandRequest shape under strict boundaries; WS8 accepts two-field transport representation with blockers but current MCP error V1 cannot carry both fields; WS6 source attribution has driven V2.2 successor and authority remains NOT_ASSIGNED. No candidate is RATIFIED. There is no overall WS2/release PASS.
