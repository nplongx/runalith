# WS2 TaskClaim CommandRequest V1.2

**Status:** `DRAFT_NOT_RATIFIED`  
**Purpose:** pin the current `runalith_sandbox::CommandRequest` serialization boundary and correct V1.1 consumer-vector provenance.

## Serialization profile

The current Rust consumer serializes `CommandRequest` using `serde_json::to_vec` in struct field order:

1. `executable`
2. `arguments`
3. `working_directory`
4. `environment`
5. `stdin`

`PathBuf` serializes as a string; `environment` is a `BTreeMap` and serializes in key order; `stdin: Vec<u8>` serializes as a JSON integer array. Locked `serde_json` version: `1.0.151`. `runalith_domain::content_hash` hashes `serde_json::to_vec(&typed_value)`; this is not JCS.

`command_sha256` covers only serialized command content. It is not the TaskClaim V4 signed preimage/subject digest, plan digest, ACL digest, provider request digest, or WS8 outer payload digest.

## Exact vector provenance

The authoritative WS3 consumer vector file contains **two** vectors. The WS2 printf vector is a separate supplement, not a third vector in the WS3 file. The producer fixture is preserved as a separate snapshot.

| Artifact | SHA-256 |
|---|---|
| WS3 consumer vectors (2 vectors) | `ef588350b9571bb0d25bdade003eecefe64329e66d57ad79c673d02dc64a1b35` |
| WS2 supplement (separate; message `93589092-401a-4854-a8a6-77d643f13a95`) | `9baf0b0cbee999ef8041bea5285021702a192cdd3e1fc718a355af973d26819e` |
| Producer fixture snapshot | `2995ea0be2b1d4465e2306021b4a4fd730be5c0d5f258d297855b8a2d0a7958f` |

The local immutable snapshot copies are:

- `02-task-claim-command-request-v1.2.consumer-vectors.snapshot.json`
- `02-task-claim-command-request-v1.2.producer-supplement.snapshot.json`
- `02-task-claim-command-request-v1.2.producer-fixture.snapshot.json`

## Positive vectors

| Vector | `command_sha256` | Execution |
|---|---|---|
| `minimal-true` | `7cdb59b2331c7eed448b46c971fe1d6dccf915ddc82ad6d1b21bca4bae55a3a5` | `NOT_RUN_FIXTURE_ONLY` |
| `unicode-env-binary-stdin` | `6e3fbfe695f74f36739e454c6cd541f7cd4c0487d2d1c9e91302e8a2d9833fb7` | `NOT_RUN_FIXTURE_ONLY` |
| `ws2-current-producer-command-vector` | `d663cd8fd7c063804596f5403532efe767ed302d01ec4f153d9c287df409c730` | `NOT_RUN_FIXTURE_ONLY` |

The separate WS2 supplement describes `/usr/bin/printf`, byte length 176. No command was executed by these fixtures.

## Negative mutations

Six negative mutations are pinned: missing executable; unknown `shell` field; non-byte-array stdin; non-string environment value; changed command with retained digest; changed digest with unchanged command. Expected outcomes are strict deserialization or digest-mismatch rejection as encoded in the fixture.

## Implementation source pins

- Sandbox `CommandRequest` source SHA-256: `90691f8de835f1997ea42058f751fa947b20572206dd05c9699da63d5d8dd618`
- Domain `content_hash` source SHA-256: `f7d098f1d5ea47f8aaa1d825309a76a8f779d7a86a3612ccfa5d1a6756009bc3`
- Locked `serde_json`: `1.0.151`

## Validation

```bash
python3 -B rust/workstreams/02-task-claim-command-request-v1.2-test.py
```

Expected result: 3 exact vectors and 6 negative mutations pass, with provenance checks proving two WS3 vectors + separate WS2 supplement + separate producer fixture snapshot.

## Limits

This establishes typed command serialization only. It does not establish TaskClaim V4 signed bytes/signature authority, a W1 compiled-task mapping, command execution, executable/argv inference from prompts or role metadata, sandbox policy authorization, ControlFence authority, or production dispatch. Sandbox source currently enforces its own execution boundaries; no mapping from W1 `host-conversation` task is approved. W1 must supply explicit versioned execution mode/template, deterministic input-to-argv/stdin mapping, workflow/task/role/version and `PlanDigestV1` binding, sandbox policy identity/version, and CommandResult-to-output-artifact contract.

## Exact artifact hashes

- Fixture: `9fdf25e450abb5c585bcc1dc213cb620d59bcd87e884c69501ffc3b5e3a48996`
- Validator: `e203b940cc2f6b105a51d30b0ee48eec09e557c38f390e10c7e74710b5357787`
- This document: compute after final write.

**Disposition:** draft only; independent WS1/WS3 review pending; not ratified.
