# WS2 Control Contract Candidate V10.38 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.37 SHA-256 `95c4230a5e916fbcc44e7dc44e56351ba87da3fed9be2f9373615d09d25633f9`  
**Purpose:** consolidate latest WS2 local validation, source-pinned Control/MCP/digest registry, V2.3.3 live-source/line inventory, independent WS3 test-projection acceptance and latest WS6/WS3 governance decisions.

## 1. Current W2 route→Store integration slice

File: `rust/crates/runalith-control-api/tests/worker_store_boundary.rs`  
SHA-256: `876db56147e70b1536e09fe8cd537d30be6d7f5c2c9c96fd674524f6b56938f6`

Scope remains integration-test-only. It composes the existing HTTP route handlers with a disposable test principal, test verifiers, an injected test-only `WorkerControlAuthority` and real temporary Store connections. No production Control API, Store, Runtime, SQL, schema, migration or manifest was changed.

Four integration tests cover:

1. Lease renewal exact replay, same renewal ID with changed TTL conflict, invalid worker and invalid TTL before Store.
2. Task-result inbox exact replay, changed semantic body conflict, stale lease rebind conflict, second event identity for the same attempt conflict, wrong worker identity before the adapter.
3. ExecutionFence V2 draft reservation/completion projection, exact receipt key sets, complete subject continuity, distinct side-effect vs Store-internal digests, exact replay, changed ACL/event conflict, UNKNOWN remains RESERVED, and unverified SUCCEEDED fails closed with 503.
4. Existing HTTP route authentication/capability and Store CAS behavior integrated through a test-only adapter.

Exact verification on this file hash:

```sh
cargo fmt -p runalith-control-api -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-control-api --test worker_store_boundary --locked --offline --jobs 1 -- --test-threads=1
cargo clippy -p runalith-control-api --all-targets --locked --offline -- -D warnings
```

Observed: 4/4 PASS; fmt PASS; all-target Clippy `-D warnings` PASS. WS3 independently re-ran the exact test target and independently accepted the receipt JSON field sets with limits (see §5).

Limit: the adapter uses process-local reservation/idempotency state and deterministic derived receipt IDs. It has no canonical signed receipt bytes, production issuer, cryptographic receipt authentication, durable public receipt lookup or Store-backed production `WorkerControlAuthority`. Standalone `/v1/worker/*` remains fail-closed with 503 when no production authority is injected. ExecutionFence V2 remains DRAFT / NOT RATIFIED.

## 2. Source-pinned Control HTTP / MCP / digest registry V1

Artifacts:

- `rust/workstreams/02-control-route-mcp-digest-registry-v1.json` — SHA-256 `c635f49d3afc8be9cfd165aa69791f819062d3a3dfb1dab65761532d04fd3f28`.
- `rust/workstreams/02-control-route-mcp-digest-registry-v1.md` — SHA-256 `d5ed4d2b71a613acc069f2d22c419a76a526f70b7b185daedc8467de34519cc5`.
- `rust/workstreams/02-control-route-mcp-digest-registry-v1-test.py` — SHA-256 `efce2d959dd785f2930ad03f53d94ed46653a827efebf92a272bd1b2efbe6d89`.

Validator:

```sh
python3 -m json.tool rust/workstreams/02-control-route-mcp-digest-registry-v1.json >/dev/null
python3 -B rust/workstreams/02-control-route-mcp-digest-registry-v1-test.py
```

Observed PASS:

- 10 source/fixture pins verified;
- 8 worker HTTP routes with capabilities;
- 8 workflow route/service/MCP relationships;
- 62 registered MCP tool names, 14 actual read-only local Gateway tools;
- JSON-RPC ID remains request identity, not durable idempotency; local Gateway sets `idempotency_key=None`; mutating service requests fail closed;
- 1 MiB MCP frame/service boundaries and digest-source anchors checked;
- 14 digest domains kept distinct, including outer PlanDigest, inner WorkflowPlan, TaskResult envelope, side-effect request digest, internal Store digest, fence completion, ACL/event/outcome, LeaseRenewal and MCP service.

The registry explicitly preserves WS1's digest clarification: `TaskClaim.plan_sha256` must bind outer `PlanDigestV1.value`, not inner `workflow_plan.plan_hash` and not W8 outer payload digest. Registry is a source inventory, not route activation or cross-part contract ratification.

WS1 and WS8 exact-hash review requests remain `queued/durable`:

- WS1 `b1b32d1e-c534-46f1-9c5a-f79a80f48288`, review outer `PlanDigestV1.value` and claim mapping.
- WS8 `3acdf7af-14bf-432b-a499-74102cd905e7`, review MCP catalog/allowlist/request mapping/digest claims.

No review response/ACK was observed through inbox seq1607; queued means broker enqueue only.

## 3. WS6 Trust live-source successor V2.3.3

Immutable predecessor artifacts V2.3.1 and V2.3.2 remain unchanged. V2.3.2 checker correctly fails closed because WS6 changed three of its pinned Trust files. WS6 explicitly requested a separate successor and an exact bounded line/function map; WS2 created V2.3.3.

Artifacts:

- `rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source.fixtures.json` — SHA-256 `ee6e40c56bb0785d08c375bd3c6cae1dcbbd53499094845bf692960bc542f66b`.
- `rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source-test.py` — SHA-256 `ff4d7aa07659f570a44d6c4d49e74edb496339b8da5bb7fc398bea7aa9f25267`.
- `rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source-note.md` — SHA-256 `9bfa4cc1175c7acf25d315315e82ffe895d8d9fd494a4d8f4ebcae1e1ee06668`.

V2.3.3 pins seven current files. Three changed since V2.3.2: `governance_receipt.rs` `7c51f6bde7e376206abd51113c5e6c72525043b18e288dae87069a792af0096`; `signed_envelope.rs` `aa836df246e27809e806e600fbb5dfd8fd0d8ba3728e605ba4d56ea5e38cc1f1`; `lib.rs` `0b8f3bcf949e3f3eaa804aae6ccd9a3b45e60e2467cdbb48a9060c413f51218f`. Other four match V2.3.2.

V2.3.3 adds bounded exact line/function attribution for:

- shared `map_signature_verification_error` in `signed_envelope.rs:21-35`;
- caller-supplied envelope verification in `signed_envelope.rs:200-215`;
- Governance signer-output self-verification in `governance_receipt.rs:231-245`;
- generic `TrustError::code` mapping in `lib.rs:96-107`;
- relevant positive/negative tests in `signed_envelope.rs:270-298`, `governance_receipt.rs:931-980`, `lib.rs:300-345`.

The new mapping separates OpenSSL/temp-file/infrastructure failures (`AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE`) from malformed key/Base64/input (caller-specific invalid code) and validly encoded but false signatures (explicit signature-invalid branch). It adds no cause code, DTO, wire field, trust domain, nonce persistence or database semantics.

V2.3.3 validator command:

```sh
python3 -m json.tool rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source.fixtures.json >/dev/null
python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source-test.py
```

Observed PASS: immutable V2.3.1/V2.3.2 pins; V2.3.1 static 29-code validator; expected V2.3.2 first drift in `governance_receipt.rs`; all seven live source hashes; exact three-file delta; seven line/function anchors; five bounded cause-code origin rows; no new cause code. V2.3.2 remains preserved and its nonzero source-drift result is not mislabeled as a runtime failure.

WS2 ran the current WS6 Trust package on the same shared candidate source:

```sh
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-trust --locked --offline --jobs 1 -- --test-threads=1
cargo fmt -p runalith-trust -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy -p runalith-trust --all-targets --locked --offline --jobs 1 -- -D warnings
```

Observed: 90/90 PASS; fmt PASS; all-target Clippy `-D warnings` PASS. This verifies local candidate tests only; no trust root, signer, issuer, nonce authority or verifier production provisioning is implied.

WS2 requested exact-hash WS6 review via `488dca42-b076-4782-aebd-6bd91481b710` (correlation `WS2-WS6-V233-EXACT-LINE-MAP-REVIEW-20261104`), queued/durable. No WS6 acceptance/ratification is yet observed.

## 4. Broader local WS2 verification on current worktree

### Rust Control / Recovery / Store

Command:

```sh
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-control-api -p runalith-recovery -p runalith-store --locked --offline --jobs 1 -- --test-threads=1
```

Observed:

- Control API: 49/49 (26 library +8 binary +11 standalone-process +4 new integration).
- Recovery: 15/15.
- Store: 99/99.
- Total: **163/163 PASS**.

Includes independent-connection CAS/race, restart/reopen exact replay, result inbox idempotency/conflict, stale lease/attempt/owner-epoch fencing, event-chain tamper detection, cancellation UNKNOWN/no-release and scheduler admission/fairness behavior. Store remains the mixed schema-v20 compatibility aggregate, not an extracted Control-only DB.

Formatting / static lint:

```sh
cargo fmt -p runalith-control-api -p runalith-recovery -p runalith-store -- --check
cargo clippy -p runalith-control-api -p runalith-recovery -p runalith-store --all-targets --locked --offline --jobs 1 -- -D warnings
```

Both PASS, exit 0.

### Rust Domain / Node compatibility

Command:

```sh
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test -p runalith-domain --locked --offline --jobs 1 -- --test-threads=1
cargo fmt -p runalith-domain -- --check
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy -p runalith-domain --all-targets --locked --offline --jobs 1 -- -D warnings
```

Observed: **62/62 PASS** (60 library +2 `skill_manifest_v2_parity` integration), fmt PASS, all-target Clippy `-D warnings` PASS. Includes Node-generated task/job terminal replay, task transition, workflow phase transition, runnable-task query, plan/canonical-byte/hash, custom workflow, policy composition and compiled-plan differential vectors.

Workspace type check:

```sh
CARGO_TARGET_DIR=/dev/shm/ws2-main-validation-target CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo check --workspace --locked --offline --jobs 1
```

Observed: PASS, exit 0; all workspace crates checked.

### Node lifecycle oracle

`node --test tests/test-workflow-m4.js tests/test-task-lease-manager.js tests/test-task-lease-expiry-race.js tests/test-workflow-terminal-failure-atomicity.js tests/test-distributed-scheduler.js tests/test-phase5-recovery.js tests/test-phase5e-recovery.js tests/test-execution-lease-fencing.js`

Observed: 8 files, 8 passed, 0 failed.

### Additional structural fixture checks

PASS:

- `02-compiled-plan-adapter-v2-test.py` — stable task ID/role binding and negative cases; **also confirms a remaining gap**: policy compatibility/evaluator still consumes positional `TaskSpec.role=custom-task-N` rather than stable `custom_role_id`.
- `02-control-worker-boundary-v2-test.py` — 26 structural negative mutations; authority/crypto/compatibility/settlement four cases explicitly NOT RUN.
- `02-control-worker-boundary-v2.1-test.py` — 32 structural negative mutations; same four non-structural cases NOT RUN.
- `02-control-journal-v1-test.py` — two journal vectors, 389 and 380 bytes; standalone serializer fixture, not a private Store hash call.
- `02-control-domain-errors-v1-test.py` — legacy Node error inventory, proposed domain codes, W8 crosswalk, UNKNOWN/no-auto-retry invariants.
- `02-legacy-node-custom-workflow-adapter-v1-test.mjs` — stable child IDs, explicit custom role/version and renumbering behavior; does not prove live attachment revision/CAS/idempotent receipt or authenticated executor.
- `02-control-route-mcp-digest-registry-v1-test.py` — 10 pins, 8+8 routes, 62 MCP tools, 14 read-only tools, 14 digest domains.
- `02-control-domain-error-diagnostics-v2.3.3-live-source-test.py` — current seven-file source snapshot and bounded line-map checks.

V2.3.2 live-source check is expected to fail on the immutable predecessor snapshot after WS6 changes; V2.3.3 is its validated successor. No predecessor artifacts were rewritten.

## 5. Latest cross-workstream / governance state

### WS3

WS3 independent review of exact W2 harness SHA `876db...` remains `ACCEPTED_WITH_LIMITS_FOR_TEST_PROJECTION_ONLY`. WS3 confirms exact receipt key sets match its `deny_unknown_fields` V2 draft consumer; internal Store full-request digest is no longer emitted; its own parser tests 3/3 and independent rerun of W2 target 4/4 PASS. This is not V2 ratification or production authority.

Latest WS3 peer-reported source update through inbox seq1605: worker `main.rs` SHA `34f2c8492daf1673b0952b634c9ef7cd1d7add7596e39384a1fadcc222962922`, `config.rs` SHA `9fc9e9e334ded3671c654569968e8b7da01f161c5446d48b9bdd651d4a64ea22`. WS3 reports worker suite 110 library +30 binary +3 integration PASS, one privileged ignored test separately rerun 1/1 in root-mapped user namespace; Clippy/fmt/build PASS. Latest peer update also reports quota library SHA `6ba1c63afae73a83959b1a0c5cab177e0f93268d1d96a1e1a93b2df5facd41ae`, quota tests 15 library +6 integration, plus privileged case separately 1/1. These are peer-reported snapshots, not W2 reruns or production Control authority.

### WS6 authority

WS6 seq1562 reconfirms: no Project Owner/Host Security appointment authority or verifiable decision artifact; provider-origin owner, signer, key custodian, independent verifier, claim/fence signed preimage, issuer/audience/scope, signing-key lifecycle, freshness/revocation/high-water, durable nonce/replay authority and acceptance approver remain `NOT_ASSIGNED / NO_DECISION / NOT_AUTHORIZED`. D-01 unresolved; D-02 separate and not approved. No provisioning, migration, ACL change or V2 ratification.

WS6 seq1560 states the W2 V2 projection is structural compatibility evidence only; no signature bytes, issuer/audience authentication, durable nonce/replay or production WorkerControlAuthority.

### A2A review state

- WS1 review of W2 route/digest registry: `b1b32d1e-c534-46f1-9c5a-f79a80f48288`, queued/durable; no response observed through seq1607.
- WS8 review of registry/MCP mapping: `3acdf7af-14bf-432b-a499-74102cd905e7`, queued/durable; no response observed through seq1607.
- WS6 review of V2.3.3 exact source/line map: `488dca42-b076-4782-aebd-6bd91481b710`, queued/durable; no response observed yet.
- WS8 reports its relay of WS2-origin provider proof review to WS4 as `331f359e-dabe-4206-9929-3c4c21056360`, queued/durable only; no WS4 read/ACK/response claimed.
- WS2 direct recipient ACL to WS4 remains denied; no ACL change.
- WS2 processed and ACKed 18 received peer messages through seq1607. A broker enqueue/ACK is not a contract decision or authority approval.

## 6. Remaining gaps and hard blockers

1. **CR-03 / Control authority:** no production Store-backed `WorkerControlAuthority`, TaskClaim issuer/signer/key custodian, signed-byte preimage or authenticated receipt; V2 remains draft. WS6 appointment authority absent.
2. **CR-09 / Common Envelope:** no live runalith-mcp wiring for mutating routes, complete approved route/deadline registry or remote authenticated route activation; dispatch review remains reference-only and blocked.
3. **W1 mapping gap:** compiled-plan V2 fixture explicitly reports current policy compatibility/evaluator uses positional role alias `custom-task-N` instead of stable `custom_role_id`; no shared source fix is authorized here.
4. **Lease/fence durability gap:** test projection completion map remains process-local; receipt IDs derived; no durable public history/replay lookup across restart, expiry or reassignment.
5. **Provider and settlement:** no independently authenticated provider terminal proof or cancellation settlement contract; local process stop does not establish provider terminality.
6. **D-01 / D-02:** no owner appointment, high-water/approval transaction owner or global writer barrier approval. No DB split, migration, shared DB cutover or provisioning authorized.
7. **Persistence extraction / deployment:** current schema-v20 Store remains mixed compatibility state; no Control-only DB, no cross-deployable independent deployment/rollback acceptance.

Issue #58 remains open for cross-workstream contract closure; #48 remains open for Workflow/Execution/Agent Session persistence ownership. No accountable Project Owner or Host Security appointment has appeared in A2A.

## 7. WS2 disposition

- Local Control/Recovery/Store tests: **TESTED — 163/163 PASS**.
- Trust candidate package: **TESTED — 90/90 PASS**; fmt/Clippy PASS.
- Node lifecycle oracle: **TESTED — 8/8 PASS**.
- Route/MCP/digest registry: **IMPLEMENTED / STRUCTURALLY VALIDATED**.
- V2.3.3 live source/line map: **IMPLEMENTED / STRUCTURALLY VALIDATED**; WS6 review pending.
- WS3 V2 receipt projection: **ACCEPTED WITH LIMITS FOR TEST PROJECTION ONLY**.
- Cross-part contracts: `DRAFT / NOT RATIFIED`.
- CR-03, CR-09: `OPEN / BLOCKING`.
- Overall WS2 acceptance and production/release readiness: **BLOCKED / NOT PROVEN**.

Main repository HEAD remains `2f3599000d9a8dd8ff61b2651478eb27ceec88f3`. All new W2 artifacts remain untracked, no files staged, no commit/push. No production source, Store schema, SQL, migration, service manifest, ACL, credentials or deployment was changed.
