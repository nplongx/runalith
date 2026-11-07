# TaskClaim V4 command field — CommandRequestV1 mapping — DRAFT

**Status:** DRAFT / NOT RATIFIED. This is a consumer-shape and digest reference only. It does not define claim signature bytes, local-execution authorization, policy or command derivation from workflow metadata.

| Artifact/source | SHA-256 |
|---|---|
| `02-task-claim-command-request-v1.1.fixtures.json` | `bb6791e9a4a3adbdc3533d014560ca8a6e68b0fe1bfc5ee2037e28a681fa25b1` |
| `02-task-claim-command-request-v1.1-test.py` | `c373c19dbc74b07410bb171114da7bb87f93a2fcfc07d42e4e64715633d68619` |
| WS3 vector file `03-command-request-v1-differential-vectors.json` | `2c6a8fdf9743786389fe2d1bfc93e4fdb957067c105cb20d1a6c780055e52532` |
| WS3 `runalith-sandbox/src/lib.rs` | `90691f8de835f1997ea42058f751fa947b20572206dd05c9699da63d5d8dd618` |
| WS3 `runalith-domain/src/lib.rs` (`content_hash`) | `f7d098f1d5ea47f8aaa1d825309a76a8f779d7a86a3612ccfa5d1a6756009bc3` |

## 1. Accepted only as current deterministic serialization shape

WS1's exact-hash review accepted `runalith_sandbox::CommandRequest` as a deterministic serialized request shape at the sandbox API boundary, not as an approved W1 task mapping or authorization. Fields are exactly:

- `executable` absolute path string;
- `arguments` string array;
- `working_directory` path relative to workspace root;
- `environment` string map, concretely a `BTreeMap` serialized in key order;
- `stdin` byte vector serialized as JSON integer array.

The current serde profile is `serde_json::to_vec(CommandRequest)` in Rust struct field order, `PathBuf` as UTF-8 string, `BTreeMap` key order, `Vec<u8>` as byte array; workspace lock pins `serde_json 1.0.151`. `runalith_domain::content_hash` is SHA-256 over `serde_json::to_vec(&typed_value)`, not JCS. `command_sha256` binds only the typed command bytes/value; it is not the claim signed-preimage, plan, ACL, execution-fence request or outer envelope digest.

## 2. Exact vectors

V1.1 contains all three vectors from WS3's current command differential suite:

1. `minimal-true`: `7cdb59b2331c7eed448b46c971fe1d6dccf915ddc82ad6d1b21bca4bae55a3a5`;
2. `unicode-env-binary-stdin`: `6e3fbfe695f74f36739e454c6cd541f7cd4c0487d2d1c9e91302e8a2d9833fb7`;
3. `ws2-current-producer-command-vector`: exact `/usr/bin/printf` JSON, 176 UTF-8 bytes, digest `d663cd8fd7c063804596f5403532efe767ed302d01ec4f153d9c287df409c730`.

The V1.1 Python validator independently reproduces all three bytes/digests and six negative mutations: missing executable, unknown field, invalid stdin byte, non-string environment, changed command with old digest and changed digest with same command. It passes `3 vectors + 6 negatives`.

## 3. WS1 mapping boundary — changes required before deriving commands

WS1 review found current `WorkflowTaskDefinition`/`CompiledWorkflowTask` do not define a command template. Current compiled tasks use `execution_mode=host-conversation`, `deterministic=false`. `CustomRoleDefinition` contains prompts/capabilities/descriptive permissions/allowed tools/skills, no executable/argv contract. Therefore current W1 cannot derive or authorize a `CommandRequest`.

Before any compiled task maps to a local command, a separate versioned contract must define:

1. explicit local-execution mode;
2. explicit versioned command source/template, with no derivation from prompt, descriptive permission, `execution.request` or free-form metadata;
3. deterministic input-artifact to argv/stdin mapping;
4. binding to workflow/task/role/version and `PlanDigestV1`;
5. sandbox policy identity/version;
6. `CommandResult` to output-artifact contract.

The enclosing authenticated claim binds workflow/task/attempt/lease/owner epoch/worker/plan/ACL; `CommandRequest` itself has no such identity. Sandbox policy independently enforces executable roots, workspace write boundary, environment allowlist, size/time/output limits and cgroup. This fixture does not choose or authorize those policy values.

## 4. Evidence and limits

WS3 independently confirmed its current Rust command vector test PASS and Node differential `node --test crates/runalith-worker/tests/worker-envelope-v1-node-parity.test.js` PASS 3/3. WS1 accepted the serialization shape with blockers and explicitly rejected inferring a W1 command mapping from current workflow metadata. WS2 V1.1 validator passed 3 exact vectors and 6 negative mutations.

No command was executed. No TaskClaim signed preimage/signature, key/issuer/audience verifier, local-execution policy, W1 adapter, Control route or production authority is proven. Active V3 remains unchanged. V4 remains DRAFT.
