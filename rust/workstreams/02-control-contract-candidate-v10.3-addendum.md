# WS2 Control contract candidate — V10.3 addendum

**Status:** DRAFT / PROPOSED / NOT RATIFIED.  
**Lineage:** V9 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5` + V10 `9fb54a38f1f97f41af6d969d6ec06fc8a779beddcf9128ce0049ffb74375b9e8` + V10.1 `345179cbe3a1affca10f42b8fe5094df971afbed78179857ac6d41a99e01bf97` + V10.2 `ca6e310b5ccc79edd4eb455d7ded6dce3b034d0341c3dc842d4fd96e29cacabd` + this addendum. Earlier versions remain immutable.

## 1. Exact WS3 consumer response / producer V2 vectors

WS3 responses:

- `1e42fc29-5a03-4e3f-8c39-bc6d5114352f`: partial consumer vectors tested, signed bytes blocked; no CommandRequestV1 mapping, V2 durable renewal journal, live Control route or WorkerStore migration.
- `4ace2344-bf6c-4b50-9c60-62c82364485f`: V1 hashes exact; `ACCEPTED_WITH_BLOCKERS_FOR_LOGICAL_CONSUMER_MAPPING_ONLY`; V1 completion request/receipt omit `idempotency_key` and `acl_sha256`, and the WS3 positive parser currently enriches these in memory. It explicitly requests a producer successor with these fields.

WS2 V2 logical producer successor:

| Artifact | SHA-256 |
|---|---|
| `02-control-worker-boundary-v2.md` | `879e840eae61e0cec5316fdbb8e9c444876d3b562be73ecd3e1504a7218d58d5` |
| `02-control-worker-boundary-v2.fixtures.json` | `e8ae78f78dbd05f6bb72976a557283d5bd6d90961a11792f8f8b72d40722d07e` |
| `02-control-worker-boundary-v2-test.py` | `2eb17630c885501f45b2df2dcffbb46374c3a885e63ea1f7579647188ae9f760` |

V2 includes both omitted fields in completion request and durable receipt, and checks the full identical subject across reservation request, reservation receipt, completion request and completion receipt. Validator: 26 structural negative mutations PASS; 4 authority/crypto/V1 compatibility/settlement cases explicitly NOT RUN. WS2 requests WS3 to add a distinct V2 snapshot/test in the WS3-owned worktree, retain V1 historical evidence, and rerun consumer tests without in-memory field enrichment. No WS3 source edit or migration is performed by WS2.

V4 command mapping remains unresolved: WS3 `try_command_request()` rejects W2 `{kind,payload}` as not a `runalith_sandbox::CommandRequest`. No claim signature/preimage/key/issuer/audience profile or signed-byte corpus exists. V3/runtime V1 remains unchanged.

## 2. WS6 exact cause-code correction and V2 inventory

WS6 message `6f8bdecd-cb97-48f0-a8e4-ff81a6fa8ac8` identified three shortened aliases in the earlier diagnostic fixture. Exact source strings are:

- `GOVERNANCE_RECEIPT_PAYLOAD_MISMATCH`
- `GOVERNANCE_RECEIPT_DIGEST_MISMATCH`
- `GOVERNANCE_RECEIPT_TRUST_SNAPSHOT_MISMATCH`

WS2 inspected WS6 source, confirmed each exact literal and preserved the V1 fixture unchanged. Diagnostic V2:

| Artifact | SHA-256 |
|---|---|
| `02-control-domain-error-diagnostics-v2.md` | `7ad1e3114d2f06bf1e1942f903b9ca8cb2254abf52d7e3dbeb889a280c433ba8` |
| `02-control-domain-error-diagnostics-v2.fixtures.json` | `97a6b376514b1af67e191ba2612cfcea380a2e0741b3c59c33b42eb461a0900c` |
| `02-control-domain-error-diagnostics-v2-test.py` | `28325de4bfbdec821f7a960452ba8339fcdb7ecb764909b73415438db41ce44c` |

The V2 inventory pins current WS6 source hashes:

- `governance_receipt.rs`: `d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09`;
- `signed_envelope.rs`: `1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f`;
- `lib.rs` (`TrustError::code()`): `5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f`.

Validator PASS: 29 exact unique cause strings, independent domain/cause fields, unresolved authority handling, nonce conflict and valid signed `Rejected` boundary. Coarse WS2 domain group mappings remain `DRAFT_PROPOSED`; no source/runtime/HTTP/route policy is frozen. WS2 has requested WS6 review of exact inventory and proposed groupings.

## 3. WS8 transport boundary

WS8 message `f824d9b0-d8c3-4386-b471-7235a2dedd08` confirms `domain_code` and `cause_code` must remain two separate opaque producer fields; neither replaces, aliases, flattens or derives HTTP/retry semantics from the other. Unknown cause remains UNKNOWN/UNRESOLVED. Disposition: `ACCEPTED_WITH_BLOCKERS_FOR_TRANSPORT_REPRESENTATION` only. No runtime schema integration, status/retry mapping, public Control route, authenticated Gateway dispatch or common-envelope ratification.

Current W8 `McpServiceErrorV1` source still exposes only `code` and `message`; the accepted mapping is documented/crosswalk-level, not implemented or proven in the W8 runtime schema.

## 4. Project Owner / authority escalation

WS3 message `974b6731-bbce-43ae-a69e-598480911194` asks Project Owner to name:

1. accountable ControlFence receipt authority owner and exact Control issuer principal, audience, scope, key/config version, ACL/nonce/replay/freshness/expiry/revocation rules;
2. separate host ProcessStop signer owner and exact signer identity/evidence scope/manifest/process/cgroup/claim/attempt/lease/epoch/worker/time binding;
3. whether the trust domains are separate and who provisions/rotates/revokes keys.

WS2 has not selected a trust domain or signer. WS6 previously confirmed: WS2 owns ControlFence issuer/receipt/CAS; WS3 owns local process/cgroup evidence and WorkerStore consumer; WS4 owns provider terminal proof; WS6 may define a distinct verifier only after Project Owner assigns a Control service identity/domain/scope/root lifecycle and ProcessStop signing owner. Do not reuse GovernanceApprovalReceipt, do not add a sixth trust domain, and do not settle cancellation from local process-stop or receipt hash alone.

Current A2A directory lists only WS1–WS8 and no Project Owner endpoint. WS2 is using the permitted WS2→WS6 edge to ask WS6 to escalate to its human Project Owner/authority owner; no ACL modification or invented owner identity. WS7 reciprocal review remains blocked by ACL and must be relayed through WS6/WS8.

## 5. Status

V10.3 is a documentation/fixture successor only. No earlier candidate was edited. No source, schema, DB, WorkerStore, manifest, route, credential, signer/verifier, migration, D-01 DB split, production dispatch, cancellation settlement, deployment or cutover was performed. Three deployables/eight workstreams remain unchanged. Contract ratification and authority prerequisites remain BLOCKED / NOT PROVEN.
