# WS2 Control contract candidate — V10.4 continuation addendum

**Status:** DRAFT / PROPOSED / NOT RATIFIED.  
**Lineage:** V9 `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5` + V10 `9fb54a38f1f97f41af6d969d6ec06fc8a779beddcf9128ce0049ffb74375b9e8` + V10.1 `345179cbe3a1affca10f42b8fe5094df971afbed78179857ac6d41a99e01bf97` + V10.2 `ca6e310b5ccc79edd4eb455d7ded6dce3b034d0341c3dc842d4fd96e29cacabd` + V10.3 `d794a15cd5a30f72cf766772bb19e9fdb6f8fa266c8e22d2e64313aff3c4c16c` + this addendum. All earlier versions remain immutable.

## 1. WS3 V2.1 producer/consumer review — accepted with blockers for logical mapping only

WS2 sent V2.1 to WS3; WS3 replied in message `2d3ab2e7-e5a0-4d95-b9fa-02b42be822b2` under correlation `COS-A2A-WS2-WS3-PRODUCER-V2.1-20261103`:

`ACCEPTED_WITH_BLOCKERS_FOR_LOGICAL_CONSUMER_MAPPING; DRAFT_NOT_RATIFIED`.

Exact artifacts reviewed by WS3:

| Artifact | SHA-256 |
|---|---|
| WS2 `02-control-worker-boundary-v2.1.md` | `4e563b01da1658a26acb58ed2426efffa70ccde9405b43c671fd3ae4a8140c19` |
| WS2 V2.1 fixture | `4c2b29f378b06cba0bfeca3ed60a6614e2a39be18f94ee5d2c03c5578a22dfbb` |
| WS2 V2.1 validator | `b679503a74c4729a7c61ed516841f2146d83a82ad9ca66abe4c0ae5f02c3cc87` |
| WS3 `draft_contracts.rs` consumer source reported in A2A response | `58a0e448160a3853a5a744fbadf00619d4006277f0731130c9e0b6fedd03977b` |
| WS3 current command vector suite | `2c6a8fdf9743786389fe2d1bfc93e4fdb957067c105cb20d1a6c780055e52532` |

WS3 owns and produced its own separate V1, V2 and V2.1 snapshots. V1 remains byte-identical and tests still reject V1 completion request/receipt for missing `idempotency_key` and `acl_sha256`. V2 remains an intermediate logical candidate and its `{kind,payload}` command sentinel is rejected by typed `CommandRequest`. V2.1 is the typed successor: full command object, full fence subject and completion echo consumed directly, without in-memory completion field enrichment. WS3's consumer test derives expected `worker_id` from the fixture instead of its earlier V1 hardcoded value.

WS3 evidence in its A2A response: `cargo test --locked --offline -p runalith-worker draft_contracts -- --test-threads=1` PASS 11/11. WS2 independently reran the targeted suite in an isolated `/tmp` Cargo target:

`CARGO_TARGET_DIR=/tmp/ws2-ws3-consumer-v2 cargo test --manifest-path rust/Cargo.toml -p runalith-worker --locked --offline draft_contracts::tests`

Result: **11 passed, 0 failed, 0 ignored**, exit 0. It covers V1 historical rejection, V2/V2.1 completion full subject, strict typed CommandRequestV1, command digest parity, fence attempt/epoch continuity, renewal logical replay and JSON-value differential vectors. This remains a draft-only consumer test; not signature/authority, WorkerStore journal, Control Store transaction, HTTP route or production integration.

## 2. CommandRequestV1 vectors and WS1 boundary review

WS3 current command vectors file SHA `2c6a8fdf9743786389fe2d1bfc93e4fdb957067c105cb20d1a6c780055e52532` contains three current typed serialization vectors. WS3's third vector is the exact producer `/usr/bin/printf` request: 176 UTF-8 bytes, command digest `d663cd8fd7c063804596f5403532efe767ed302d01ec4f153d9c287df409c730`.

WS2 issued an immutable command-vector successor:

| Artifact | SHA-256 |
|---|---|
| `02-task-claim-command-request-v1.1.md` | `5f29fbc96262111f48cabec1420fbfe49c74a550b1c62baa2021c3918f5279ea` |
| `02-task-claim-command-request-v1.1.fixtures.json` | `bb6791e9a4a3adbdc3533d014560ca8a6e68b0fe1bfc5ee2037e28a681fa25b1` |
| `02-task-claim-command-request-v1.1-test.py` | `c373c19dbc74b07410bb171114da7bb87f93a2fcfc07d42e4e64715633d68619` |

Validator PASS: 3 exact Rust consumer serialized-byte/hash vectors + 6 negative mutations. Current observed profile is `serde_json::to_vec(CommandRequest)` in struct field order; `PathBuf` is a UTF-8 string; environment is `BTreeMap` order; stdin is JSON byte integer array. `runalith_domain::content_hash` is SHA-256 of `serde_json::to_vec(&typed_value)`, not JCS. Sandbox source snapshot SHA `90691f8de835f1997ea42058f751fa947b20572206dd05c9699da63d5d8dd618`; domain source snapshot SHA `f7d098f1d5ea47f8aaa1d825309a76a8f779d7a86a3612ccfa5d1a6756009bc3`.

WS1 response in message `f5013f51-172e-4ab7-a8f3-9f04111c80d9`: **ACCEPTED WITH BOUNDARIES; CHANGES REQUIRED BEFORE ANY W1 COMPILED-TASK MAPPING; DRAFT_NOT_RATIFIED**. Exact current W1 sources do not provide a command template: `WorkflowTaskDefinition` and `CompiledWorkflowTask` carry task/role/version/dependencies/input/output contracts, current compiled tasks use `execution_mode=host-conversation` and `deterministic=false`, and `CustomRoleDefinition` has prompts/capabilities/descriptive permissions/allowed tools/skills but no executable/argv contract. Do not derive executable/argv from prompts, metadata, `execution.request` permission or other free-form descriptions.

Before W1 can map a compiled task to a local command, a separate versioned contract must define explicit local-execution mode, command source/template, deterministic input-artifact to argv/stdin mapping, binding to workflow/task/role/version/PlanDigestV1, sandbox policy identity/version, and CommandResult-to-output-artifact semantics. CommandRequest has no workflow/task/attempt/lease/epoch identity; the authenticated enclosing claim must bind those separately. WS1 made no source changes and ratified no W1 command mapping.

## 3. Diagnostic source attribution successor V2.1

WS1 independently confirmed V2 diagnostics 29 codes and found one source attribution omission: `AGG_APPROVAL_SIGNATURE_INVALID` occurs in `governance_receipt.rs` and `signed_envelope.rs` (and the separately inventoried approval-decision pipeline). V2.1 records every observed source path, pins `approval_decision.rs`, and separately inventories 24 exact ApprovalDecision code strings without assigning them an unreviewed WS2 `domain_code`.

| Artifact | SHA-256 |
|---|---|
| `02-control-domain-error-diagnostics-v2.1.md` | `10d3c422673343840d7681dc8e01416bbc61cb41294f6820990e8741d94dd9d0` |
| `02-control-domain-error-diagnostics-v2.1.fixtures.json` | `2d0a783a136f03eace44180733d2690864b7428075db5b54cdf1105f4128fcfc` |
| `02-control-domain-error-diagnostics-v2.1-test.py` | `861083dded8b7a827bec3fea49ec2ab91f7eacb61eaa4821d749658b72142b32` |

Validator PASS: 29 exact mapped cause codes; correct multi-source attribution; 24 additional ApprovalDecision literals inventoried separately, deliberately unmapped; `domain_code` and `cause_code` remain distinct; AUTHORITY_UNAVAILABLE preserves exact cause and UNKNOWN/UNRESOLVED; nonce rebinding stays non-retryable; valid signed `Rejected` remains a domain decision. The separate inventory does not claim all `runalith-trust` errors or map approval decision outcomes into Control semantics.

WS8 response to diagnostics V2 in message `368ac8f1-d721-4bd7-8ea8-52387f1a77b0`: `ACCEPTED_WITH_BLOCKERS_FOR_TRANSPORT_REPRESENTATION`. WS8 independently ran V2 validator and accepted separate opaque `domain_code`/`cause_code`, exact string preservation and UNKNOWN/UNRESOLVED handling. It explicitly did not accept per-case WS2 domain group correctness, runtime verifier, Gateway schema, HTTP status/retry, Control route/auth or dispatch. V2.1 source-attribution successor is sent for follow-up review; no schema integration is requested.

## 4. Owner and production gates

- Project Owner has not named an accountable WS2 owner or ControlFence authority owner. WS3's separate message `974b6731-bbce-43ae-a69e-598480911194` asks for exact Control issuer/audience/scope/key, nonce/freshness/revocation rules and a distinct host ProcessStop signer authority. WS2 relayed these questions to WS6 through the permitted WS2→WS6 edge; no approval/appointment is yet evidenced.
- WS2 owns ControlFence issuer/receipt/authoritative CAS semantics; WS3 owns the worker DTO, exact durable retry journal, WorkerStore format/compatibility and local process/cgroup facts; WS4 owns provider account/run/terminal truth; WS6 owns trust-root/verifier policy only after a named Project Owner assigns a distinct Control identity/domain/scope/root and host ProcessStop signing owner; WS8 owns transport and independent field preservation.
- No production claim issuer/key, signed-byte profile, canonical TaskClaim V4 preimage, duplicate-key rule, durable nonce authority, Control projection transaction/freshness fence, ProcessStop signer or settlement authority is approved.
- V1 incomplete/unbound WorkerStore rows remain historical UNKNOWN/UNRESOLVED; no attempt synthesis, account lookup or replay. No DB migration, route, source implementation, signer provisioning, production dispatch, cancellation settlement, D-01 split, deployment or cutover.

## 5. Current overall disposition

Logical fixture/consumer convergence has materially improved and is independently tested. WS3 accepts V2.1 with blockers for logical mapping only; WS1 accepts the CommandRequest serialization shape but rejects W1 command derivation until a new W1 contract exists; WS8 accepts the two-field transport representation with blockers. WS6 source names and diagnostic groupings remain under review. No contract is `RATIFIED`; there is no overall WS2 or release PASS.
