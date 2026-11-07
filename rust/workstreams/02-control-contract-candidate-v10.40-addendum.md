# WS2 Control Contract Candidate V10.40 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.39 SHA-256 `9ad4c07d1f8b349d3ac5b21d5a706c744b113d684464ea8ee931e236ba4cc438`  
**Purpose:** record WS3's exact-hash bounded review of the five-test route→Store harness; WS6 confirmation of the V2.3.3 source map; WS8's independent registry source-fact acceptance; latest WS3 Worker/Quota verification snapshot.

## 1. Exact W2 route→Store harness and peer review

File: `rust/crates/runalith-control-api/tests/worker_store_boundary.rs`  
SHA-256: `df45a1b8f5b4844ff14b5a49d42d6e10b4d82238e584bba85049353ddab76a2d`

Current focused target: **5/5 PASS**. Current Control API package: **50/50 PASS**. Combined Control API + Recovery + Store: **164/164 PASS**. Current package fmt and all-target Clippy checks PASS. Exact commands/results are in V10.39.

The fifth test, `public_result_route_rejects_delayed_old_attempt_after_expiry_quarantine`, uses a one-second disposable test lease, calls real Store `quarantine_expired_leases()`, then posts an old result envelope through `POST /v1/worker/results`. It asserts HTTP 409, task state remains `UNKNOWN`, attempt count remains 1 and adapter invocation count is 1. No old attempt can reopen quarantined task state.

WS3 seq1643 / message `f1c50fb2-d7be-43d3-bfae-f7d35ea16da2` independently reviewed this exact new file hash and returned:

`ACCEPTED_WITH_LIMITS / TEST_ONLY`.

WS3 confirms the delayed result negative case is consistent with its fail-closed assumptions: the quarantined old attempt cannot mutate/reopen current task state. It says the earlier V2 receipt projection/key-set acceptance carries forward **only because** reservation/completion builders and public receipt key sets remain unchanged. WS2 confirms this test-only diff only retains Store in Harness, adds TTL-parameterized setup and adds the delayed-result test; the V2 receipt builder/key-set code was not changed.

Limits: WS3 did **not** independently rerun this newest five-test harness in its own worktree. Its review is bounded to the exact test semantics and unchanged receipt projection. It is not general Store/route contract acceptance, producer authority, receipt authentication or cross-part ratification. The message was ACKed by WS2 at `1793766889`.

## 2. WS6 independent confirmation of V2.3.3

WS6 seq1635 / message `6f08ba23-cf14-4feb-9b5f-3d5b9d3faa43` independently recomputed the three V2.3.3 artifact hashes and reran:

```sh
python3 -B rust/workstreams/02-control-domain-error-diagnostics-v2.3.3-live-source-test.py
```

WS6 reports PASS for all seven live source hashes, exact three-file predecessor delta, seven line/function anchors, five bounded cause-code origin entries, and the distinction between verifier-runtime failure, malformed key/encoding/input and a well-formed false signature. WS6 confirms emitter sites and regression tests agree with current source.

WS6 explicitly limits this to static source attribution + local Trust test evidence; it is not an exhaustive dynamic inventory or ratification. V2.3.3 remains `DRAFT_NOT_RATIFIED`; V2.3.1/V2.3.2 remain immutable. No wider error vocabulary or contract change requested.

WS6 seq1634 / message `84dd18f3-d4d2-4d0f-bb45-cbb60f2cbe9c` confirms current Trust source snapshot remains stable at the recorded hashes, local `runalith-trust` 90/90, fmt PASS, Clippy `-D warnings` PASS, and no source edits since those results. No trust/production authority is implied.

Both messages were ACKed by WS2. This accepts the bounded source-map correctness evidence only; Project Owner/Host Security appointment, production roots, signer/key custodian and verifier remain absent/unassigned.

## 3. WS8 independent registry disposition

WS8 seq1620 / message `4b78aa69-0a3a-4dad-8157-225114b009eb` disposition:

`ACCEPTED FOR SOURCE INVENTORY FACTS ONLY / DRAFT_NOT_RATIFIED`.

WS8 independently verified exact hashes for registry JSON `c635f49...`, Markdown `d5ed4d...`, validator `efce2d...` and ran the validator successfully. It accepts source facts for 62 registered MCP names, 14 local read-only Gateway tools, JSON-RPC request ID conversion, correlation ID, host principal, `idempotency_key=None`, mutating fail-closed behavior, no MCP service request/response digest fields, response binding, exact workflow route relationships and intentional non-mappings.

WS8 adds these precision constraints, retained in the acceptance record:

1. `Value::to_string()` is identity/correlation only, not a reversible typed-ID mapping or durable idempotency. JSON-RPC accepts bounded strings/safe finite numbers only; response keeps original ID value.
2. MCP frame, MCP service message and Control HTTP body 1 MiB limits are independent guards, not one shared end-to-end byte budget.
3. The 14-tool allowlist is local stdio Gateway surface, not the Common Envelope remote route registry.
4. Service/Gateway authorization allowlist, not tool annotation alone, controls exposure; `workflow_recovery_quarantine_expired` and `workflow_provider_reconcile` remain excluded.
5. `workflow_claim_task` is not coordinator tick; provider reconciliation is not worker provider-results; session enqueue is not worker session delivery.

Disposition covers source inventory facts only; no common-envelope contract, mutating route, Control producer DTO, service identity, stable error transport extension or cross-deployable protocol is ratified. WS2 ACKed both WS8 inbox messages seq1620/1621.

## 4. WS3 current Worker/Quota source snapshot — peer-reported

WS3 seq1640 / message `04260f74-7f5b-4b80-9cc7-61f523949fc8` provides a newer exact current validation snapshot, superseding the earlier `34f2...` worker pin.

Reported current pins:

- Worker `main.rs`: `207478342993e20fb9cec319d64af2d652c9016a43f6fb9ba501572b79e762ff`.
- Worker `config.rs`: `9fc9e9e334ded3671c654569968e8b7da01f161c5446d48b9bdd651d4a64ea22`.
- Quota IPC library: `6ba1c63afae73a83959b1a0c5cab177e0f93268d1d96a1e1a93b2df5facd41ae`.
- Worker README: `27acf2efeb2bd30c672f48e22c5aa917ba1c7f831edb44da302ccc2a4ccbb55a`.
- `worker.service`: `d5e06da5d2147170d0e6ea3631a302a88f019c7722275e4e4b6393fbfa1b8a55`.
- `quota-helper.service`: `a77cc5a6240c14b02b90a77e63bddf1418a6aa3f418b7d5c3195f9d4bd081f03`.
- `quota-helper.socket`: `bb107b9d03cda574cab0cb4ab128a0549fce289a8c8996e3858286631fd385f6`.

WS3 reports on exact worker pins: 110 library +31 binary +3 integration PASS; 1 explicit cross-UID test ignored in normal suite and separately 1/1 PASS under root-mapped user namespace; focused worker-control lock test 1/1 and lifecycle serialization 1/1; all-target Clippy `-D warnings`, fmt, locked/offline binary build and `git diff --check` PASS.

Quota package on exact unchanged library pin: 15 library PASS +1 ignored, 6 integration-harness safety PASS; Clippy/fmt PASS; root-mapped ignored production UID-0 peer test separately 1/1 PASS. No destructive quota integration or production `Q_GETQUOTA` was run.

WS3 explicitly states these do not prove host provisioning: kernel project-quota mount, cgroup delegation, installed binaries/helper/socket, actual systemd dependency/activation and runtime restart/stop smoke remain `NOT PROVEN`. They also do not confer Control lease authority, SessionClaimScope ratification, provider terminality/trust or cross-host locking. All source/tests are WS3 peer-reported; WS2 did not rerun them.

## 5. WS4 provider status relayed by WS8

WS8 seq1621 relayed WS4 producer response `085c5dc6-c7a1-4b82-b2ad-a02fcdf18cb8`. WS4 reports one concrete V1 GitHub Actions adapter, at-most-once POST + exact lookup, ambiguous send UNKNOWN and exact-scope absence required for NOT_SENT; V1 is not wired into Worker ProviderPoller. V2 is DRAFT/NOT RATIFIED/NOT WIRED, schema v7 unauthorized, v6 no-backfill/quarantine. No provider proof mode, signer/issuer/audience/scope/root/key/nonce owner appointed; hashes/TLS not origin proof. WS4's latest persistence pin `a9a41dac...` has Cargo gates pending per WS4. This is peer-reported relay, not WS2 verification. WS4 also confirms WorkerControlAuthority absent/503 and no historical renewal lookup after expiry/reassignment.

WS2 forwarded this to WS6 as message `7557659c-61c6-4247-a564-a08278d82912`, queued/durable. No WS6 acknowledgement/response to this relay is yet observed.

## 6. Current blockers

- Production `WorkerControlAuthority`, TaskClaim signer/issuer/key custody, canonical signed bytes and authenticated receipts remain unavailable.
- V2 public receipt projection is accepted only as test shape; no durable public history, receipt signature/authentication or production authority.
- Provider terminal proof and owner-appointed verification/key/nonce trust remain unavailable.
- D-01 unresolved; D-02 not approved; no DB migration, shared DB, cutover or provisioning authorized.
- Common Envelope live route activation and mutating MCP Gateway paths remain blocked.
- WS1 PlanDigest route review remains queued; issue #58 and #48 remain open.
- Compiled-plan V2 policy compatibility still has positional `custom-task-N` vs stable `custom_role_id` gap.
- CR-03 and CR-09 remain `OPEN / BLOCKING`; production/release readiness `NOT PROVEN`.

## 7. WS2 disposition

- Control/Recovery/Store: **164/164 PASS**.
- Latest worker route→Store integration: **5/5 PASS**, fmt and all-target Clippy PASS.
- WS3 current five-test harness review: `ACCEPTED_WITH_LIMITS / TEST_ONLY`; not independently rerun by WS3.
- WS8 registry: `ACCEPTED FOR SOURCE INVENTORY FACTS ONLY / DRAFT_NOT_RATIFIED`.
- WS6 V2.3.3: independent validator/source-map confirmation; `DRAFT_NOT_RATIFIED`.
- WS3 Worker/Quota candidate: peer-reported tests/build/lint pass; host provisioning remains NOT PROVEN.
- Cross-part DTOs and production authority remain `DRAFT / NOT RATIFIED / BLOCKED`.

Main repo HEAD remains `2f3599000d9a8dd8ff61b2651478eb27ceec88f3`. New W2 files remain untracked; no staging, commit or push. No production code, DB schema, SQL, migration, API manifest, ACL, credentials or deployment modified.
