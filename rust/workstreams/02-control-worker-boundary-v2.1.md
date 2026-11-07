# WS2 Control / Worker boundary V2.1 — DRAFT

**Status:** DRAFT / NOT RATIFIED / NOT CRYPTO GOLDEN.  
**Parent logical vector:** V2 fixture SHA-256 `e8ae78f78dbd05f6bb72976a557283d5bd6d90961a11792f8f8b72d40722d07e`.  
**V2.1 fixture:** `02-control-worker-boundary-v2.1.fixtures.json`, SHA-256 `4c2b29f378b06cba0bfeca3ed60a6614e2a39be18f94ee5d2c03c5578a22dfbb`.  
**V2.1 validator:** `02-control-worker-boundary-v2.1-test.py`, SHA-256 `b679503a74c4729a7c61ed516841f2146d83a82ad9ca66abe4c0ae5f02c3cc87`.

V2.1 preserves the complete V2 claim/fence/renewal/provider crosswalk, and replaces the non-typed `{kind,payload}` command sentinel with an exact logical `runalith_sandbox::CommandRequest` shape. It does not alter V2, V2.1 parent docs, V9–V10.3 candidates, or any production code.

## 1. CommandRequestV1 field map

Consumer implementation `runalith_sandbox::CommandRequest` uses these exact `deny_unknown_fields` fields:

- `executable`: absolute path serialized as UTF-8 string;
- `arguments`: array of strings, no shell parsing;
- `working_directory`: path relative to workspace root, serialized as UTF-8 string;
- `environment`: string map; Rust type is `BTreeMap`, so serialization key order is lexical;
- `stdin`: byte vector serialized as JSON integer array in range 0..255.

V2.1 embeds the existing `minimal-true` consumer differential vector:

```json
{"executable":"/usr/bin/true","arguments":[],"working_directory":".","environment":{},"stdin":[]}
```

Exact serialized JSON bytes are pinned by the fixture. `command_sha256` is `7cdb59b2331c7eed448b46c971fe1d6dccf915ddc82ad6d1b21bca4bae55a3a5`, the existing consumer `content_hash(CommandRequest)` vector. A second Unicode/environment/binary-stdin vector is also pinned (`6e3fbfe695f74f36739e454c6cd541f7cd4c0487d2d1c9e91302e8a2d9833fb7`). Source consumer vector file SHA-256 `55fc6229bc5cb7c3c16b18bc8e67371bf3849bb18a196d30d88ba281e20e17bd`.

This is a proposal to map `TaskClaimEnvelopeV4.command` to the current consumer `CommandRequestV1` structure and `command_sha256` to the current CommandRequest value digest. It does not define TaskClaim V4 signed preimage or include the command in a cryptographic claim signature; those remain separate unapproved digest domains. Current W3 serializer evidence does not itself ratify a cross-part producer mapping.

## 2. Fence / claim / renewal crosswalk retained from V2

V2.1 retains exact equality of `attempt`, `owner_epoch`, claim/workflow/task/lease/worker/plan, side-effect ID/kind/request digest, reservation idempotency key and ACL digest through reservation request, reservation response, completion request and durable completion receipt. Completion request and completion receipt both include `idempotency_key` and `acl_sha256`; this corrects the known V1 fixture omission.

LeaseRenewalV1 request and durable receipt remain separate from ExecutionFence. Same logical heartbeat reuses exact request body, renewal ID and original receipt/expiry. Changed bytes under same renewal ID conflict. No WorkerStore journal is implemented here.

W4 `request_binding_sha256` still equals the W2 provider-dispatch fence `request_sha256`; provider payload digest and W8 outer payload digest stay separate domains (equal only in the exact sample where they cover the same object). V2.1 validator recomputes the exact W4 request-binding and payload digest values.

## 3. Evidence and limits

CommandRequest fixture validator `02-task-claim-command-request-v1-test.py`, SHA-256 `e31b57dec2de0acb41f01ae7b2066d6439cad05008ad92d43cfe2140540fab1b`, passes two exact consumer byte/hash vectors and six negative mutations. V2.1 validator passes **32 structural negative mutations**, including the six command field/digest mutations; four authority/crypto/V1 compatibility/settlement groups remain explicitly NOT RUN.

No command executes. No signer, signature, issuer/audience verifier, Control route, Store/WorkerStore journal, transaction, lease settlement, provider dispatch or production authority is exercised. `authenticator` remains `fixture_only` / `NOT_A_SIGNATURE`.

## 4. Consumer review required

WS3 should add a V2.1 snapshot in its own worktree, keep its V1 fixture as the historical negative/compatibility case, and run its draft consumer tests against the V2.1 fixture with these changes:

1. do not enrich completion request/receipt in memory when V2.1 already contains the complete fields;
2. use the expected worker ID from the fixture/claim (the current V1 helper hardcodes a different worker ID);
3. verify strict `TaskClaimEnvelopeV4Draft`, `CommandRequest` deserialization and `command_sha256` vector;
4. verify complete subject/attempt equality across all four fence DTOs and exact completion/renewal replay;
5. preserve separate tests for V1 missing fields, no V1-to-V2 synthesis and historical WorkerStore rows remaining UNKNOWN/UNRESOLVED.

No WS3 source/test/worktree is edited by WS2. WS3 must decide whether current serde fields and this proposed claim command mapping are sufficient and publish its own consumer result.

## 5. Owner and release boundaries

WS2 owns Control producer semantics and receipt/CAS. WS3 owns worker DTO parser, durable retry journal and WorkerStore compatibility. WS1 must review the deterministic plan-to-command adapter if command derivation from compiled tasks is needed. Project Owner/authority must approve claim issuer/key/role and signed-byte profile before V4 can be authenticated. No source implementation, WorkerStore/Control Store migration, signer provisioning, dispatch, DB split, settlement, deployment or cutover is authorized.
