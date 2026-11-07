# WS2 Control Contract Candidate V10.33 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.32 SHA-256 `e55b9a0f18e4971180ae6c87c8b6f8af0aa987c0b833e6d03941161658f948e9`  
**Purpose:** pin independently rerun WS6 trust-crate verification and reconcile it with the still-unassigned production authority gates. This is peer evidence, not WS2 ownership or authority appointment.

## 1. WS6 isolated source snapshot

Worktree `/home/long/work/chatgpt-adapter-ws6-20261103`; HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`. WS6 Rust source remains isolated/untracked/unmerged.

Exact source hashes before and after independent WS2 verification:

- `crates/runalith-trust/src/lib.rs`: `b980bd06ce815f2dfd9135841358dc336221da0374342f7d9785745d426c6b5a`
- `crates/runalith-trust/src/domain_prefixed_signature.rs`: `87745d58729810715a5eac371e5073ec743df718e069f967b8c47a1dec17ef80`
- `crates/runalith-trust/src/governance_service.rs`: `32863cb05d741601e8f80c317d22c5a950ebb340942714811eb5ac4611320c54`
- `crates/runalith-trust/src/trust_snapshot.rs`: `7c4554cdef25fbb7531ba11e51b113ad6d57a85cf4ebc47d1350dfd72c110d54`

The independently rerun package test command from WS6 `rust/`:

`CARGO_TARGET_DIR=/dev/shm/ws2-ws6-review-target cargo test -p runalith-trust --locked --offline --jobs 1 -- --test-threads=1`

Observed result: **87 passed, 0 failed**; doc-tests 0/0 and exit 0. It includes the WS6 hardening regression `domain_prefixed_signature::tests::rejects_untrusted_host_labels_and_oversized_envelopes_before_crypto` and tests for signed receipt verification, audience/scope binding, signature tampering, nonce replay, high-water/revocation, and trust snapshot integrity.

On the same source tree:

- `CARGO_TARGET_DIR=/dev/shm/ws2-ws6-review-target cargo fmt -p runalith-trust -- --check` — PASS (exit 0).
- `CARGO_TARGET_DIR=/dev/shm/ws2-ws6-review-target cargo clippy -p runalith-trust --all-targets --locked --offline --jobs 1 -- -D warnings` — PASS (exit 0).

Post-validation source hashes were recomputed and remained equal to the four pins above. WS2 did not edit WS6 sources, tests, manifests or key configuration.

## 2. What this evidence does and does not establish

This verifies the local `runalith-trust` crate and its test adapters. It does not appoint a production signer, trust root, key custodian, provider identity, issuer, audience, scope or durable cross-process nonce service. A test-only SQLite adapter, local mutex or injected port is not production authority. A valid local Ed25519 test vector does not authenticate a W4 provider terminal proof in production.

WS6-owned `rust/workstreams/06-governance-authority.md` exact SHA-256: `e79cc53592ca9a04d8bb704fa860527982e204f1582001f3cfda078d0489b45d`. Provider-origin proof proposal `rust/workstreams/06-provider-origin-proof-proposal.md` SHA-256: `737d90395bcae9a6e541436e0ca7e884538905715a2670ec703b2e56d079d253`.

WS6's current authority disposition in that brief is explicit:

- Project Owner / authorized architecture owner: `NOT_ASSIGNED`.
- Host Security / platform key-custody authority: `NOT_ASSIGNED`.
- Production signer/private key/root custodian and verifier service: absent.
- Provider trust domain, issuer/provider/account/audience/scope identity: not selected.
- Durable cross-process/restart nonce authority and D-01 freshness/revocation-to-Control-commit fence: not implemented/appointed.
- Provider-native signed proof vs authenticated-adapter-read observation: both remain proposal modes; neither selected or ratified.
- Current registry remains five trust domains; no sixth provider-origin/source-attestation domain is approved.
- TaskClaim issuer remains WS2/Control, worker consumer/audience remains WS3/Execution, and WS6 trust/key work remains conditional on explicit appointment and a ratified profile. TaskClaim V4 fixture authenticator is `NOT_A_SIGNATURE`.

WS6 also records D-01 (approval-high-water database/transaction ownership) and D-02 (global writer barrier) as separate unresolved owner decisions; neither authorizes migration or cutover.

## 3. A2A limitation in this continuation

WS6's brief records the same broker-layer failure observed here: A2A inbox calls can fail with `Unknown tool: cos-control-broker-a2a-inbox-read`; no subsequent reply/ACK should be inferred. The current continuation's attempts to use A2A inbox/send methods also returned `Unknown tool` for the broker action. No new WS2→WS6, WS1, WS3 or WS8 message is claimed sent by this addendum. Existing historical replies remain evidence only at their previously recorded sequence/message IDs; do not treat them as a new appointment or ratification.

## 4. Overall WS2 disposition after V10.33

Current addendum chain:

- V10.31: `2379e9bc4362209120374fda2ca578aa2842f985d3e2299ab3bcdf893c5430bc` — exact current WS3 110+15 tests, fmt, Clippy; WS8 dispatcher 41/41 plus Node/Rust 5/5; WS1 plan digest clarification.
- CR-09 review V4: `4ff12ddd714119db238f6dd44d804d0601a6fe275128b7a7ea2f8308c25895d3` — current WS8 reference dispatcher semantics accepted with blockers only.
- V10.32: `e55b9a0f18e4971180ae6c87c8b6f8af0aa987c0b833e6d03941161658f948e9` — WS2 Control API/Recovery/Store 159/159 tests, fmt and Clippy.
- V10.33: this WS6 trust-crate independent review and authority boundary.

The WS2 primary crate source pins and results remain as recorded in V10.32. WS3 consumer renewal retry remains accepted with blockers; WS2 Store CAS/idempotency remains locally implemented/tested while public HTTP/Store adapter and authenticated receipt are blocked. TaskClaim signing/authority remains unassigned. WS4 provider v7 columns and legacy v6 no-backfill/quarantine remain proposed; migration not approved. WS8 Gateway code remains reference-only; live MCP integration/production replay/auth/routes remain unproven.

**CR-03:** `OPEN / BLOCKING`. **CR-09:** `OPEN / BLOCKING`. D-01/D-02 unresolved. All contracts `DRAFT_NOT_RATIFIED`. Production/release readiness `NOT_PROVEN`.

No production source, schema, SQL, migration, trigger, ACL, credentials, signer, route or deployment changed. No commit or push. New WS2 evidence remains untracked.
