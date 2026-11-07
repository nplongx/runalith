# WS2 continuation — A2A review and verification delta

**Date:** 2026-11-03. This file supplements `02-implementation-handoff-20261103.md`; it does not alter prior evidence or ratify a contract.

## Contract artifacts

- V9 base candidate: `02-control-contract-candidate-v1.md`, SHA-256 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5`.
- V10 DRAFT addendum: `02-control-contract-candidate-v10-addendum.md`, SHA-256 `9fb54a38f1f97f41af6d969d6ec06fc8a779beddcf9128ce0049ffb74375b9e8`.
- Original verification handoff SHA-256: `319159288068921c2f69a3d2c7a76aab282a27d06ceb14b53256580bf88c5d8c`.

V10 is the immutable V9 base plus the exact addendum above. Neither version is RATIFIED.

## New review evidence

- **WS3 observation mapping:** exact additive mapping successor SHA-256 `27845d70edbacd6f279cb1e3e4e3e214afb1bacee8218d0915061e50cae3694a`; example SHA `601f0e9787709e60f145b69cf717549668f93edec4a768c273c483ce05b01d7e`; validator SHA `7524842367ba7c7e16db5123f4ee454555c056f71560206781f90ed244527e38`. It distinguishes W3 semantic message ID, W2 TaskResult event ID/digest/idempotency, and W8 outer payload digest. Control inbox receipt is durable receipt only, not nested evidence verification. WS2 accepted this exact additive clarification with blockers in reply `086dd3fe-9a53-41a5-8fbc-bfdc841fb529` to WS3 message `dc402b4c-4b95-42e1-aeff-a1c741d8fbf5`.
- **WS3 claim/fence feasibility:** WS3 confirmed explicit `acl_sha256` at TaskClaimEnvelopeV4 top level, explicit attempt in the execution-fence subject, V3 unchanged, local ProcessStop unsigned/local-only, and versioned renewal/fence changes feasible once canonical vectors exist. Worker files and WorkerStore journal/migration remain WS3-owned. WS2's V10 review request is A2A message `31c8eddc-f274-4391-95b7-b319d4218c89`.
- **WS6 current Governance receipt:** source SHA `54a9822e7715840daf51538ffe049172d8fcbca430a37cca17be9fd051fad6ba`; TrustSnapshot SHA `7c4554cdef25fbb7531ba11e51b113ad6d57a85cf4ebc47d1350dfd72c110d54`; fixture SHA `3abfff2a5c7d7442341251ba1637cd32297bed31f1f84c9ac3da65d9cb076c5a`. WS2 independently reran `cargo test -p runalith-trust --locked --offline` (72/72), `cargo fmt -p runalith-trust -- --check` and warning-denied Clippy (both PASS). SQLite nonce adapter is `#[cfg(test)]` only; production nonce persistence owner remains UNASSIGNED. WS2 V10 review request id `c6539c73-c5ac-4b03-9345-8c53c2968a51`.
- **WS8 wire crosswalk:** WS8 accepted the V9 crosswalk with blockers. WS2 confirmed producer identity from authenticated host context and audience from authenticated route/host configuration, independently checked by receiver. WS8 R5.1 successor message `7e910527-3e87-4a6b-9802-ae3eabe1678e` reports R5.1 archive SHA `22a8dc5bd5df7a088b734aa5cb369a563cb07d3bfb96faef760367d9f2f76db2`, manifest SHA `4e94472609436a5655aa062094efd47e31790e9d39fe5945b82a9d27f7cd4eea`, and includes current W2/W3/WS6 artifact hashes. Common Envelope remains DRAFT; no routes/auth/deployment approved. WS2 V10 review request id `77e33757-7802-4435-b7f4-35251fc39a21`.
- **WS1:** Handoff message `5d72e02b-6aa6-429d-98ee-8dbe9058443e`; WS1 ACK/review message `30e567d7-9389-4403-ae1d-87bfed112909` confirms mapping-only disposition and warns that WS7 cannot reply to WS2 under current ACL. WS2's follow-up notice id `5a9eb85e-825e-4abe-b561-f2160e3f8295` informs WS1 that V10 leaves its mapping unchanged.

## Trust authority relay

WS3 could not send directly to WS6 due recipient ACL and asked WS2 to relay questions about a distinct ControlFenceReceipt verifier and WorkerProcessStopAttestation trust policy. WS2 relayed them over the allowed WS2→WS6 edge in message `578b2fcf-491c-4722-b4a8-686675881fa2`, correlation `COS-A2A-WS3-WS6-AUTHORITY-RELAY-V1-20261103`. WS2 replied to WS3 in message `212ded8b-ffb6-41c2-a0a2-432d6849aafe`: relay sent; WS6 response pending. No reuse of GovernanceApprovalReceipt or trust-domain extension is assumed.

## Further local verification

Additional Node checks all passed:

- `node tests/test-workflow-plan-m2.js`
- `node tests/test-workflow-policy-m1.js`
- `node tests/test-workflow-plan-structural-contract.js`
- `node tests/test-workflow-role-input-coverage.js`
- `node tests/test-policy-contract.js`
- `node tests/test-success-contract.js`
- `node tests/test-workflow-policies-mcp.js`
- `node tests/test-langgraph-orchestrator.js`

The plan adapter fixture test passed 2 positive + 17 negative checks. The journal serialization fixture passed both exact vectors. These remain isolated fixture/Node compatibility evidence, not live cross-deployable acceptance.

## Open items

- WS2, WS3, WS6, WS7 and WS8 accountable owners remain UNASSIGNED.
- WS7→WS2 reciprocal A2A ACL edge is absent. WS2→WS7 request was durably queued; there is no direct WS7 review response. No ACL was modified.
- WS6 response to the ControlFenceReceipt/ProcessStop authority relay is pending.
- WS3, WS6 and WS8 review responses to the V10 addendum are pending; a queued request is not a review ACK.
- Proposed new WS2 error strings in V10 are DRAFT and require fixtures/review. Existing Node oracle values `ILLEGAL_ACTIVE`, `TERMINAL_REOPEN`, `INVALID_PHASE_TRANSITION` are observed compatibility values; no new HTTP mapping is assigned.
- Production claim authority, cancellation settlement, terminal recovery disposition, same-task cross-deployable retry, D-01 split/projection and deployment remain BLOCKED.

No source/schema/DB/manifest/route/credential/deployment change, ACL modification, commit, or contract ratification occurred in this continuation.

## V10/V10.1 review status update

- WS3 V10 review response: message `99ca2a4e-f81f-4a56-bafe-d73a3a0e719e`, `ACCEPTED_WITH_CLARIFICATIONS / NOT RATIFIED`. Clarified `attempt` must remain identical through reservation request/response, completion request and durable completion receipt. WS2 accepted in reply `090de727-dab7-45a6-a4fa-62578d62166e`.
- WS8 V10 review response: message `6ee386bb-0107-472c-b231-bc56abb7fe63`, `ACCEPTED_WITH_BLOCKERS_FOR_TRANSPORT_REPRESENTATION`. WS8 confirms exact W2 `domain_code` preservation and distinguishes inner schema errors from outer envelope negotiation. WS2 replied `8e6eb95c-5f13-48e1-a6db-4d35321b9c62`.
- WS6 V10 review response: message `803ac906-c589-4ea3-9108-0c98a19808c9`, `REVIEW_ACCEPTED_WITH_BLOCKERS`. Supplied exact projection fields and diagnostic distinctions. WS2 replied `3c2d46e7-eb34-420a-8598-fbe3c9e57fd9`.
- WS1 V10 handoff review ACK: message `841b4f81-c164-45fa-9e21-ff0130f4b94f`, `RECEIVED_AND_REVIEWED`; ACKed by WS2.
- V10.1 captures the WS3 completion-receipt clarification, WS6 projection/diagnostic detail and WS8 transport representation. Exact V10.1 SHA-256: `345179cbe3a1affca10f42b8fe5094df971afbed78179857ac6d41a99e01bf97`.
- V10.1 review requests are durable queued: WS3 `610b2798-b7f5-4414-97b1-b070300c3e0c`, WS6 `90d0dce3-517a-4293-ba76-b43efa70106a`, WS8 `11329431-ada3-46f8-974f-d6315a2d0a15`. At last pull after seq 494, no response was yet received.
- WS2 relayed WS3's separate ControlFenceReceipt/WorkerProcessStopAttestation authority questions to WS6 using `578b2fcf-491c-4722-b4a8-686675881fa2`; the WS6 authority decision remains pending. No trust domain, issuer, signer or verifier authority is inferred.

V10 and V10.1 remain DRAFT. No ratification or implementation permission follows from these review dispositions.

## V10.1 successor review and latest WS6 evidence

- WS3 reviewed the exact V10.1 SHA-256 `345179cbe3a1affca10f42b8fe5094df971afbed78179857ac6d41a99e01bf97` in message `43fefced-2258-44a0-86e1-4dcadbc660cf`: `ACCEPTED_WITH_CLARIFICATIONS / DRAFT_NOT_RATIFIED`. It confirms the attempt/fence subject continuity across reservation request/response and completion request/durable receipt. WS3's current proposal SHA-256 is `efa04fd1440565e221a8b41e39736d7e44f50370c038e4e9f98adfeaddf8fb3c`. Exact WS2 producer DTO fields, canonical bytes, receipt ID/persisted timestamp and executable vectors remain WS2-owned outputs.
- WS8 reviewed V10.1 in message `0ed99492-ae0e-4e87-88bb-bdc675b86a2b`: `ACCEPTED_WITH_BLOCKERS_FOR_TRANSPORT_REPRESENTATION`. It confirms field continuity and owner split. Still no canonical request/response/completion/receipt vectors, WorkerStore V1 compatibility or production route/auth. WS2 replied `caa7ec2b-a2b6-4208-bd3b-e643362c8a6d`; original was atomically ACKed.
- WS6 latest Governance source revision: `rust/crates/runalith-trust/src/governance_receipt.rs` SHA-256 `d7119002b5940d5ed8873923189e49686f1160346a6f9a4409c0ad2b10d4b56e`. WS2 independently ran `cargo test --manifest-path rust/Cargo.toml -p runalith-trust --locked --offline`: **73 passed, 0 failed**, including full receipt exact replay after reopening the test-only SQLite nonce adapter; fmt and warning-denied Clippy also PASS. WS2 replied `d6bd6169-73ad-4075-b4ab-46526082fada`; original WS6 test addendum was atomically ACKed. This remains test-only SQLite, not production nonce persistence.
- WS3 mapping successor SHA-256 `27845d70edbacd6f279cb1e3e4e3e214afb1bacee8218d0915061e50cae3694a` was ACKed by WS3 in seq 500 / message `2737653f-2e8a-49fc-b855-fbd992d60b7d`; WS2 ACKed it.

## WS2 error vocabulary fixture

- Added `02-control-domain-errors-v1.fixtures.json`, SHA-256 `b96171623243de29603a2c96aec23fe740e2b8c415aadb088313c8f04df8b476`.
- Added `02-control-domain-errors-v1-test.py`, SHA-256 `25ab77a0130f037111c2d06af92786853f8d9aa1130e71ad57029e9002cae8e8`.
- `python3 rust/workstreams/02-control-domain-errors-v1-test.py`: PASS — exact Node legacy code inventory; proposed code uniqueness/non-aliasing; W8 mapping constraints; UNKNOWN/UNRESOLVED and no automatic retry for ambiguous mutations. This validates fixtures only, not handler/API behavior and does not ratify the codes.
- WS2 sent W8 review request `2a33620c-bb3a-4d78-9c42-c0c60dbc760b` and WS6 diagnostic-boundary review request `c3083256-154b-4a99-a75f-ba84e08d7243`. Responses pending.

Latest WS2 inbox pull after seq 509 returned no new events. The separate WS6 authority decision requested by WS3 through message `578b2fcf-491c-4722-b4a8-686675881fa2` remains pending. WS7 reciprocal ACL is still absent; no ACL change was made.

## WS2 producer-side vectors and diagnostic cause codes

- Added `02-control-worker-boundary-v1.md`, SHA-256 `196af0c5fc6be8d7e4846f9ce7909ca73a9ca9d314678477fcd99ff0441e8b94`. It records current WS2 Store struct field crosswalk and DRAFT proposed receipts. Source inspection confirms `WorkerExecutionFenceRequest` and `WorkerExecutionFenceCompletion` already carry first-class attempt and the same immutable subject. Current compact Store receipt JSON lacks explicit `receipt_id` and does not repeat the full subject; surrounding durable typed record/event does carry it. Current `TaskLeaseRenewalRequest` and `TaskLeaseRenewal` lack `claim_id`/`receipt_id`; `renewed_at` is the persistence timestamp. Worker HTTP v1 request is `{renewal_id, claim, lease_seconds}`, while current `HttpControlPlane::renew_lease` generates a new ID per invocation and has no same-heartbeat retry path.
- Added `02-control-worker-boundary-v1.fixtures.json`, SHA-256 `3f00ee830c292ac1d0baf984a49e30d665ecdde1c0610ae966c955d6cb2e41bd`, plus validator `02-control-worker-boundary-v1-test.py`, SHA-256 `4b5a6de12704909ad6ee97ef16b74faee6280324ed35819558a6b80ab5235d63`. `python3 rust/workstreams/02-control-worker-boundary-v1-test.py`: **PASS 3 positive logical groups + 18 negative mutations**. Checks claim V4 ACL binding, fence reservation/completion/receipt subject continuity, renewal exact-retry/full-receipt rules. Fixture-only: no Rust Store/API, signature, DB transaction or worker integration execution.
- WS2 sent WS3 producer DTO/vector review request `5df0d6de-9ec2-4dc1-99ef-163d2f1e0e0b`, queued durable. Review asks WS3 to confirm V4 claim mapping, fence request/response/completion/receipt fields, renewal mapping and exact canonical vectors. Response pending at this update.
- WS6 diagnostic review specified a closed cause-code list. Added `02-control-domain-error-diagnostics-v1.fixtures.json`, SHA-256 `61e90ebbe5240e3d6803ebac0be51a7681ae33f0b9fedca16b9b45568e9b110e`, plus validator `02-control-domain-error-diagnostics-v1-test.py`, SHA-256 `43c59c097e2ff56f8503f3e58e5ed6875de2c66385e6defd4af5c7f7b798e7eb`. Test PASS 4 checks: exact cause inventory/domain grouping, AUTHORITY_UNAVAILABLE preserves precise cause_code and UNKNOWN/UNRESOLVED, nonce conflict is non-retryable IDEMPOTENCY_CONFLICT, valid signed Rejected remains a domain decision rather than auth/transport error. WS2 replied to WS6 in `b2e0824f-d31a-4683-ae9b-02eb18aa805f`; original diagnostic review message `f6326687-8123-4a19-bea1-dc81f2120ca9` was ACKed via reply.
- WS8 reviewed the original error fixture in seq 527 / message `0f3eff63-098b-4c72-9f0c-c9b2f8b4b6a0`: `ACCEPTED_WITH_BLOCKERS_FOR_FIXTURE_LEVEL_TRANSPORT_PAIRING`. WS2 replied `bf034e1b-7bf5-4dfe-a014-e48cc8b3fd09`. New `domain_code` + `cause_code` diagnostic fixture review request to WS8 is queued as `297968c4-b08d-4e04-b2e8-6c9b04ddc5dc`; response pending.

## Authority decision relay and additional A2A updates

- WS6 authority response seq 532 / message `6244e7f5-c4e0-46cb-a60c-46a2950ae4db` confirms: WS2 owns ControlFence receipt semantics/issuer/CAS; WS3 owns worker consumer/journal and process/cgroup facts; WS4 owns ProviderTerminalProof. WS6 can define a separate verifier policy only after Project Owner assigns distinct Control-service identity/domain/scope/root lifecycle. Process-stop signing authority must also be explicitly named. No GovernanceApprovalReceipt reuse, no sixth trust domain, no keys/signers/routes/settlement. WS2 ACKed seq 532 and forwarded decision to WS3 in message `57a1a050-4ce3-461b-a5d5-3a8b887eac16` (queued durable).
- WS6 seq 533 / message `76f1a50c-be40-4cca-8fea-416a1d1cac26` repeated the V10.1 review disposition with exact owner boundaries; WS2 replied `6fea375c-d61d-4343-9649-b7572ae807e9`.
- WS6 continuation response seq 545 / message `70f364d4-6551-4ff5-9c64-97fe71508523` confirmed receipt of the continuation report and relay/review messages; WS2 ACKed it.
- WS1 continuation response seq 528 / message `8640dfb9-55f0-4f63-9586-9c74952dc24f` confirms V10.1 leaves W1 mapping unchanged, runtime attachment/lifecycle/policy reapproval remains NOT PROVEN, and WS7 ACL asymmetry requires Project Owner + endpoint owners. WS2 ACKed.
- WS8 R5.2 content-addressed successor handoff seq 538 / message `2d47ed6a-7d63-4b39-bdbe-f9cc8fc8aad5`: archive SHA-256 `103c7044f8cc1499cd967deb951cfbc823b471caa2a05a01f9caafe88b3aa6ab`; manifest SHA-256 `a1f5c6e428edf36e774e6ce715675a4bbffc6361fc63a684441cf75a4fa04162`; 61 entries. It includes WS2 V10.1 and original error fixture, WS3/WS4/WS5/WS6/WS7 successor artifacts. WS8 explicitly keeps common envelope DRAFT/NOT RATIFIED and no routes/auth/deployment/DB cutover. WS2 ACKed seq 538.
- Latest WS2 inbox pull after seq 545 returned no further events. WS7→WS2 ACL edge remains absent; no ACL was changed.

WS6 latest verification: source d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09; WS2 rerun 75/75 tests, fmt PASS, warning-denied Clippy PASS. Test-only OS child-process nonce adapter; production owner remains unassigned.
