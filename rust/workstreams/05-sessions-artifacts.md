# Workstream 5 — Sessions & Artifacts

**Deployable:** Execution Workers. **Status:** proposed boundary; owner unassigned. See the [master eight-part plan](../EIGHT_PART_PARALLEL_PLAN.md).

## Mandate

Own execution-side session delivery facts and immutable artifact bytes/metadata. Supply verifiable references, not trust decisions.

## Ownership

- Runtime session identity/binding, ACL/grants and session history.
- Message enqueue, delivery, ACK and UNCERTAIN state; delivery idempotency and session expiry observations.
- Content-addressed artifact bytes, typed metadata, digest/readback and immutable retention.
- Artifact references, producer/task/attempt lineage and execution result packaging.

## Explicit non-ownership

No workflow/task lifecycle or lease; no provider dispatch truth; no approval or reviewer identity; no decision that content is VERIFIED/trusted; no AGG candidate/checkpoint state.

## Current code map

`runalith-artifacts`; session-related tables/modules currently in `runalith-store`/`runalith-runtime`; result-reference pieces of `runalith-execution-persistence`; Node `agent-session-store.js` and artifact stores. Current combined-store session persistence is transitional, not an Execution ownership proof.

## Public outputs

`SessionRefV1`, `SessionDeliveryRequestV1`, `SessionDeliveryReceiptV1`, `ArtifactRefV1`, `ArtifactManifestV1` and `ArtifactLineageV1`. Artifact reference binds content digest, type/schema, producer service, workflow/task/attempt and immutable creation identity.

**Consumes:** claim/session scope from workstream 3; provider result references from workstream 4; trust/verification requirements from workstreams 6–7.

## Parallel development

Artifact immutability and digest/readback; schema validation; session ACL and delivery queue; ACK/uncertain replay; lineage validation and orphan collection using disposable stores.

## Delegated implementation snapshot — 2026-11-03

The current bounded implementation is confined to the already-registered
`rust/crates/runalith-artifacts` crate; it does not edit the shared Store,
Runtime, Worker, root workspace manifest or lockfile.

Implemented locally (contract version `1.0`, still a draft pending consumer
review):

- `src/contracts.rs`: typed `ArtifactRefV1`, `ArtifactManifestV1`,
  `ArtifactLineageV1`, `ArtifactSourceV1`, `SessionRefV1`, explicit
  `SessionAclV1` grants, `SessionDeliveryRequestV1`,
  `SessionDeliveryReceiptV1`, and `SessionExpiryObservationV1` with
  `ACTIVE` / `EXPIRED` / `UNKNOWN` states.
- `src/read_port.rs`: draft semantic `ArtifactReadPortV1`. The strict request
  contains `contract_version`, `request_id`, `correlation_id` and the exact
  `ArtifactRefV1`. For each read attempt, Execution host supplies
  `source_service_id`, `observation_id` and canonical `observed_at` separately;
  these are bound into the observation, never accepted from request JSON. The
  local adapter reports `AVAILABLE`, point-in-time `NOT_FOUND`, `UNAVAILABLE`,
  `INTEGRITY_FAILURE`; the host can produce `NOT_AUTHORIZED` before storage
  access. The local port records but does not authenticate host identity, and
  does not expose a remote route.
- Artifact references bind exact SHA-256 ID, byte length, media/schema type,
  producer service, workflow/task/attempt, correlation identity and canonical
  UTC creation time. Manifests enforce producer/attempt lineage, uniqueness,
  bounded references and deterministic JSON bytes.
- Delivery receipts bind the exact canonical request digest. Exact same-attempt
  duplicates are idempotent; changed receipts conflict; `UNCERTAIN` and
  acknowledged delivery cannot be retried. A successor attempt after rejection
  is classified as explicit-only and requires the host to independently verify
  pre-send proof; a proof reference string alone is deliberately insufficient.
- `ArtifactStore` exposes typed `read_ref`, `verify_manifest`, `put_manifest`
  and `read_manifest_bytes` operations. Exact stored bytes are re-read and
  digest-verified before publishing a manifest. These checks establish local
  byte integrity, not producer authentication or evidence trust.
- `tests/fixtures/artifact-manifest-v1-golden.json` publishes one exact
  cross-language `ArtifactManifestV1` golden vector. Rust integration tests
  compare DTO serialization against its exact UTF-8 bytes/hash and round-trip
  the artifact + manifest through `ArtifactStore`; an independent Node test
  reconstructs the fixed field order and verifies the same bytes/digests.
- `tests/fixtures/artifact-read-port-v1-golden.json` plus
  `tests/read_port_golden.rs` and root `tests/test-artifact-read-port-v1-golden.mjs`
  cover exact request, AVAILABLE and NOT_FOUND canonical UTF-8 bytes and
  independent SHA-256 domains. Negative Rust fixtures reject unknown/duplicate
  fields, metadata over 16 KiB, and mismatched host service/observation/time.
- `tests/fixtures/provider-terminal-lineage-v1-w4-golden.json` and
  `tests/provider_lineage_w4_integration.rs` consume exact W4-owned v1.0
  examples without editing W4. The integration test stores response bytes,
  canonical W4 sidecar bytes and an optional opaque Governance receipt as two
  or three regular W5 content-addressed refs in one manifest; it checks the
  sidecar's response binding and schema ID/version but does not validate trust.

Focused verification command:

```sh
cargo test -p runalith-artifacts --locked --offline -- --test-threads=1
```

Remaining integration work: host-side authentication of producer, claim scope
and pre-send proof; adapters to W2/W3/W4 public contracts; session DTO Node/Rust
golden fixtures and role-permission semantic parity; additional manifest golden
vectors (including parent refs, null schema fields and JSON escaping); consumer
review and authenticated cross-service tests. Existing
`runalith-worker/src/sessions.rs` plus `WorkerStore` remains the active legacy
durable delivery queue and is not migrated to these draft types. Its envelope
already binds workflow/task/attempt, owner epoch, lease, worker, session,
recipient and expiry, but it does not carry the canonical session-created-at
and claim identity required to construct the new `SessionRefV1` without
inventing authority. W3/W2 must publish the exact claim/session/receipt fields
and clock semantics before that adapter is wired. Session persistence in the
combined Store/Runtime remains transitional and is not modified by this pass.
No Execution DB split, migration or cutover is authorized or performed.
Workstream accountable owner remains `UNASSIGNED`; this snapshot is
implementation evidence, not Owner approval or production acceptance.

## Acceptance

1. Exact content bytes reproduce the published digest; existing content IDs cannot be overwritten.
2. Producer, task, attempt and source binding are verified; missing lineage stays untrusted.
3. ACL and delivery replay/duplicate handling is deterministic under crash/reopen.
4. Consumers use ArtifactRef APIs and never open the Execution store or filesystem directly.
5. Artifact presence alone never marks evidence VERIFIED or task COMPLETED.

## Ownership record — fill before coding

| Field | Value |
|---|---|
| Accountable owner | UNASSIGNED |
| Branch/worktree | Existing shared checkout `/home/long/work/chatgpt-adapter`, branch `main`; no isolated W5 worktree was created because the repository already contains extensive dirty/untracked parallel work. The current shared HEAD at final inspection was `2f3599000d9a8dd8ff61b2651478eb27ceec88f3`, not an immutable W5 commit. W5 files remain untracked. All source edits stayed in disjoint W5-owned paths; W4/W8 worktrees were read-only. |
| Exact files/crates | W5 semantic implementation boundary is `rust/crates/runalith-artifacts/**`. Changed `src/sessions.rs`, `src/contracts.rs` (crate-visible validators only), `src/lib.rs` (module export), added `src/read_port.rs`, `tests/manifest_golden.rs`, `tests/read_port_golden.rs`, `tests/provider_lineage_w4_integration.rs`, and fixtures `artifact-manifest-v1-golden.json`, `artifact-read-port-v1-golden.json`, `provider-terminal-lineage-v1-w4-golden.json`. Root Node tests: `tests/test-artifact-manifest-v1-golden.mjs` and `tests/test-artifact-read-port-v1-golden.mjs`. Updated this W5 handoff. No crate/workspace manifest or lockfile, W3 Worker, W4 source, W8 source, shared Store/Runtime or Node runtime/oracle files were edited. |
| Contract version | Draft `1.0` `ArtifactRefV1` / `SessionDeliveryReceiptV1` and related W5 contracts |
| Consumer reviewers | Workstreams 2, 3, 4, 6, 7, 8 owners |
| Acceptance commands/evidence | `cargo fmt -p runalith-artifacts -- --check`; `cargo test -p runalith-artifacts --locked --offline -- --test-threads=1`; `cargo clippy -p runalith-artifacts --all-targets --locked --offline -- -D warnings`; Node golden and legacy fault-oracle suites. Local crate accepted with cross-workstream blockers; no production acceptance. |

## Continued implementation and verification — 2026-11-03

**Status:** bounded WS5 implementation hardening is IMPLEMENTED and TESTED locally. The v1.0 contracts remain DRAFT/PROPOSED; the accountable owner is still UNASSIGNED and no consumer ratification or independent service acceptance is recorded.

### Changes in the WS5-owned session adapter

- ACL replacement now requires the host-authenticated subject to hold an unexpired `MANAGE_ACL` grant in the **current persisted ACL** at the supplied canonical UTC time. The requested replacement ACL cannot bootstrap its own authority. Exact operation replay remains a no-op; changed operation bodies conflict; stale revisions fail. Tests cover denied mutation, explicit self-revocation and denied follow-up after that revocation.
- Added a validated immutable `read_session` lookup and bounded `list_deliveries` history page (1–256 rows) using an exclusive lexicographic `message_id` cursor. The ordering is explicitly not represented as event chronology or a source-authoritative sequence.
- Session, ACL, delivery, receipt and expiry-observation read paths now validate decoded persisted identities and contract bindings. Delivery reads fail closed when state, attempt, transport identity, transport-start marker or exact receipt are inconsistent, including a receipt that predates the start marker.
- Added a typed persistence-integrity error for malformed or contradictory durable W5 records. No schema version, table, migration or store topology was changed.
- Added the semantic `ArtifactReadPortV1` request/observation contract. The local `ArtifactStore` adapter maps absent objects to point-in-time `NOT_FOUND`, backing I/O faults to `UNAVAILABLE`, and corrupt/unsafe objects to `INTEGRITY_FAILURE`; `AVAILABLE` returns only exact bytes whose digest and length match the immutable reference. A host-auth adapter can construct `NOT_AUTHORIZED` without touching storage. The port has no completeness, generation or freshness assertion (WS7-owned), is not a network route, and does not authenticate peers.
- Published `tests/fixtures/artifact-manifest-v1-golden.json` (`runalith.artifact-manifest.v1.golden-001`): artifact SHA-256 `8768010843d5c54824d02db72b01935dafe7fbb81e09072d5bce9a64b0ac323c`, exact manifest canonical UTF-8 SHA-256 `08a16a9c4ec41378b5fc276bf056f5bb429e1e76e078d12bb010c6a692887e3a`. Rust and Node independently reconstruct and compare exact bytes; artifact and manifest digest scopes remain separate.
- Published read-port vector `runalith.artifact-read-port.v1.golden-001`: exact request SHA-256 `2da86591bf66584e0ec0cc0048e0ea97c55c2c38e023f0571e0b80aaad9feda1`, AVAILABLE observation SHA-256 `b97357cd91e83cae56f167ec4ce74921145530959b1dab006437a711831b4824`, and NOT_FOUND observation SHA-256 `491340401f0670c59e8b611216b888033350c0fcd07f13259bdc0ee217b134be`. The per-attempt host identity, observation ID and time are not in caller request JSON.
- Published W4 packaging fixture with source schema/example/validator hashes and exact sidecar bytes. The W5 integration test covers both W4 examples and optional opaque receipt packaging; W4 validator in its owner worktree separately passed 2/2 examples plus two negative cross-binding checks.

### Verification evidence

Rust crate-local checks (all PASS on the final run):

```sh
cargo fmt -p runalith-artifacts -- --check
cargo test -p runalith-artifacts --locked --offline -- --test-threads=1
cargo clippy -p runalith-artifacts --all-targets --locked --offline -- -D warnings
node tests/test-artifact-manifest-v1-golden.mjs
node tests/test-artifact-read-port-v1-golden.mjs
```

Final Rust verification completed **37 unit tests + 6 integration tests passed, 0 failed** (43 total), covering read-port dispositions and DTO goldens, cross-language manifest bytes, W4 response/sidecar/optional receipt packaging, ACL authorization/revocation, bounded history/cursor, corrupted-state fail-closed, artifact immutability, digest/readback and restart-to-UNCERTAIN. `cargo fmt --check` and Clippy with warnings denied both passed. An earlier Clippy attempt found an unused import; it was removed before the final passing run.

Read-only Node compatibility/fault-oracle checks (all PASS):

```sh
node tests/test-agent-session-store-boundary.mjs
node tests/test-session-delivery-boundary.js
node tests/test-session-enqueue-atomicity.js
node tests/test-session-transport.js
node tests/test-artifact-manifest-v1-golden.mjs
node tests/test-artifact-read-port-v1-golden.mjs
WORKFLOW_DATA_DIR=<private-0700-temp-dir> WORKFLOW_DB=<private-0700-temp-dir>/workflow.db node tests/test-m2-artifacts.js
```

The Node tests exercised API/host ownership boundaries, durable delivery and enqueue atomicity, SIGKILL/reopen behavior, duplicate and two-process races, ambiguous transport outcomes, artifact compatibility and both shared golden vectors. Node independently emits fixed-order canonical JSON for manifest and read DTOs and checks exact UTF-8 bytes plus digest domains. `test-m2-artifacts.js` requires a disposable directory with mode `0700`; its rerun with that configuration passed. It logged the existing warning that a legacy registry backfill was skipped because the disposable schema had no `openclaw_session_key` column; the test still reported `M2 ARTIFACTS PASS`.

These Node suites are behavioral-oracle evidence for the legacy implementation, not proof that the draft Rust v1.0 DTOs are byte-for-byte or semantically ratified against Node. In particular, the current Node role permissions (`OBSERVE`/`MESSAGE`/`EXECUTE`/`TAKEOVER`) and the draft Rust session grants (`READ`/`SEND`/`ACKNOWLEDGE`/`MANAGE_ACL`) are not claimed equivalent.

### A2A coordination and unresolved contracts

- WS5 endpoint `7860fbee-58d9-483e-a0d5-df34785fbec1` is active. The peer directory did not expose recipient ACL membership. New-message send attempts to WS2 (`437be3a9-103a-4a76-b214-a5925207df30`), WS3 (`ea54914b-66e9-41ed-b051-ad315bacd6fd`) and WS6 Governance Authority (`be6f2ea2-e6af-4758-a2c8-d72701d60a85`) were each rejected with `Sender endpoint is not authorized by recipient endpoint ACL`; no message IDs were issued. Inbound pull and replies to existing messages worked. No Google Chat fallback was used.
- Earlier replies to WS3 seq 220 and 262 were queued as `08f3937b-1804-4c48-9360-661e624cf9dc` and `19e37cde-3102-4a89-a958-5ea53c7e72b3`; WS4 seq 226 as `e1d50bc6-6f06-411f-b25f-800df5ad2423`; WS7 seq 227 and 256 as `669fc65d-79e5-4f7a-aca0-7ef029dfe4fb` and `7d2e5ff5-606d-4891-a015-b5c82c3a69cc`. WS7 seq 278 received a durable read-port proposal reply (reply ID not captured in the tool transcript); WS7 seq 322 was answered by `9517f3f4-0454-4b92-8cd7-b1e8f72130cc`. WS3 seq 350 was answered by `a5271182-47ab-45a0-a520-a8163029440b`; WS4 seq 296 by `21a5043b-9232-4a17-ac1f-4e11343fd896`. Each reply was durable and atomically ACKed its original request. The initial WS7 status reply misstated seq 363 as 367; a separate correction message `c5e53fdb-c792-4ba4-9686-fcfe606b4089` was durably queued to WS7 with the correct seq 363. WS7 seq 363 / `efbcebed-bad3-49a0-85f3-adc42c750b35` was explicitly ACKed after reading its response. WS8 seq 180, 203, 246, 292 and 308 were explicitly ACKed; WS8 seq 285 received a W5 contract review reply. Queued replies do not prove recipients read or ACKed them.
- WS3 supplied TaskClaimEnvelope v3 fields `claim_id`, issuer/audience, issued/expires time, workflow/task/attempt, `owner_epoch`, `lease_id`, `worker_id`, plan/command digests, idempotency key and authenticator/ACL decision digest. Its nested session message has message/idempotency, workflow/task/attempt, owner_epoch, lease, worker, session, recipient role/type, payload and expiry, but no `claim_id`, canonical `session_created_at`, explicit W5 ACL reference or ACL digest. WS3 explicitly does not ratify W5 v1.0. Our reply proposes claim/lease/worker facts remain W3/Control-owned authenticated outer scope or linked scope reference, while W5 owns immutable session identity/time and ACL record; no fields were added pending W5 owner + Control decision.
- WS3 follow-up seq 262 / `267016ab-bdd4-4fe8-9371-adcd238e7fbd` proposes a linked immutable `SessionClaimScopeRefV1` containing claim_id, workflow_id, task_id, attempt, lease_id, worker_id, owner_epoch, plan_sha256 and claim_digest, sourced only from the verified outer TaskClaimEnvelope. WS3 assigns W5 session ID/time/expiry/registry/ACL, Control/WS2 transaction-time lease/epoch/session/current-ACL revalidation, and WS8/host-auth producer principal + canonical claim digest. WS3 seq 350 / `89cf349d-c3ab-44d0-8be3-6d650c81bd12` asked for current status; W5 replied `a5271182-47ab-45a0-a520-a8163029440b`. Current `SessionRefV1` fields remain `contract_version, session_id, workflow_id, task_id, attempt, owner_service_id, created_at, expires_at`; `SessionDeliveryRequestV1` remains `contract_version, message_id, idempotency_key, session, sender_service_id, recipient_subject_id, payload, created_at, expires_at`. No claim_id/owner_epoch/lease/worker binding, session ID/time generator, producer principal mapping or expiry-policy service has been added. `register_session` persists a supplied reference; it does not mint authority. Only local adapter read/ACL methods changed; no W3 queue integration, DTO successor, storage schema or route. WS3 does not ratify v1 or authorize schema/ACL/DB/route changes.
- WS4 initially requested changes for missing provider/fence lineage, then published its owner-worktree schema/example/validator for `runalith.provider-terminal-lineage` v1.0. Source hashes: schema `a6f4a80d7b55de904e646052b24961c95c42f80017c684dd9bee6ba7de9275b5`, example `ed185999c8e38cdb34bcad05fcdfff628de898762ba76ea7bd0e37ef94fc2646`, validator `dbbedf36fb4b76eafc00bf5c98ca7ac30642f4f5bf4615538225d811e670cc22`; W4 validator returned 2/2 examples plus two negative cross-binding checks PASS. W5 added a derived fixture and integration test: exact response bytes + canonical W4 sidecar bytes + optional opaque Governance receipt are two/three regular W5 ArtifactRefs under one manifest, with schema ID/version on the sidecar and response artifact binding checked. W5 test passed both W4 examples. Reply to WS4 seq 296 (`4d691511-d449-4bf6-8443-c13ccb19f42f`) was durably queued as `21a5043b-9232-4a17-ac1f-4e11343fd896`; disposition accepts generic packaging with blockers only, not provider status/fence authority or Governance receipt trust.
- WS7 confirmed producer result/completion IDs and contract/result-lineage digests belong to W2/W4 producers and are composed by WS7; lease/owner_epoch/plan digest remain W2/W3 claim scope; `created_at` is not a durable event ID or sequence. W5 now has manifest/read request/observation golden vectors. No W5 artifact-created event or authenticated remote read route exists.
- WS8 handoffs confirm common envelope v1.0.0 remains DRAFT/NOT RATIFIED, with no approved remote service client, public route registry, authentication mapping or negotiated-version enforcement. WS5 ACKed the handoff/correction events; no common envelope ratification is inferred.
- WS8 later sent version-negotiation evidence at seq 246 / `5336c4be-5943-419c-a2d5-874f6e65b746`: JSON Schema structural checks 11/11, standalone std-only major/minor negotiation tests 8/8, protocol 35/35 and MCP 78/78, plus clippy/fmt. The negotiation primitive remains isolated and is not wired into Gateway dispatch; the common envelope stays DRAFT / NOT RATIFIED. WS5 ACKed the handoff. Distinct artifact/manifest/session-request/outer-envelope digest domains and authenticated read-only routes remain open.
- WS7 seq 256 accepted the metadata mapping `ACCEPTED_WITH_BLOCKERS_FOR_CONSUMPTION; NOT RATIFIED`. WS7 seq 278 requested a read-port proposal; W5 replied with exact local hashes/fixtures. WS7 seq 322 requested owner/revision and consumer findings; W5 reply `9517f3f4-0454-4b92-8cd7-b1e8f72130cc` confirmed exact shared-main hashes and that no immutable owner commit exists because WS5 remains UNASSIGNED and files are untracked. WS7 seq 363 / `efbcebed-bad3-49a0-85f3-adc42c750b35` returned `ACCEPTED_WITH_BLOCKERS_FOR_LOCAL_READ_CONSUMPTION`, `DRAFT_NOT_RATIFIED`, confirming the strict DTO/golden byte behavior and downstream public API smoke 3/3; WS5 explicitly ACKed it. Remaining blockers: no authenticated remote route; no source generation/completeness/freshness; no retention/delete/GC/tombstone; 32 MiB object vs 1 MiB MCP frame transfer unresolved. The WS7 disposition applies only to local read semantics, not a cross-deployable API or evidence verification.
- WS6 trust/provenance review remains NOT RECEIVED. A new review request covering opaque verification receipt schema, verifier identity, trust snapshot/revocation/freshness and negative cases was rejected by the WS6 recipient ACL; no message ID or delivery/ACK exists. No independent trust, signature or checkpoint verification is inferred from the opaque W4 Governance receipt stored as bytes.
- WS2/Control pre-send fence review remains NOT RECEIVED. A new request for exact claim/lease/worker/owner-epoch/current-ACL transaction fence and authorization-receipt schema was rejected by WS2's recipient ACL; no message ID or delivery/ACK exists. The W3/Control dependency therefore remains BLOCKED rather than inferred from W5's local ACL adapter.
- `ArtifactRefV1`, `ArtifactManifestV1`, `ArtifactLineageV1`, `SessionRefV1`, `SessionDeliveryRequestV1` and `SessionDeliveryReceiptV1` remain DRAFT v1.0. The proposed mapping of W3/W4/W6/W7 fields, service authentication, freshness/revocation and host-level read authorization is not RATIFIED.
- No Worker integration, production session transport, DB split, migration, cutover, trust provisioning, external provider dispatch or deployment was performed.

### Acceptance classification

| Area | Status | Evidence / remaining gate |
|---|---|---|
| Content-addressed artifact bytes, immutable writes, digest/readback and typed manifest lineage | IMPLEMENTED / TESTED | Rust crate-local tests; producer authentication and independent evidence trust remain separate gates. |
| W5 session registration, explicit ACL, enqueue idempotency, one-shot delivery, receipt and UNCERTAIN recovery | IMPLEMENTED / TESTED | Rust crate-local tests plus Node fault/reopen oracle tests; no integration into the W3 Worker queue. |
| ACL mutation authority and persisted-read integrity | IMPLEMENTED / TESTED | Current-ACL `MANAGE_ACL`, explicit self-revocation and corrupted state/receipt rejection tests. |
| Bounded session history/read API | IMPLEMENTED / TESTED | Stable lexicographic cursor with a 1–256 bound; not a chronology/sequence guarantee. |
| Versioned local ArtifactReadPort semantics | IMPLEMENTED / TESTED / ACCEPTED WITH BLOCKERS BY WS7 | Strict request/observation DTOs; host identity, per-attempt observation ID and UTC time supplied out-of-band and bound in observation; 16 KiB metadata cap; five outcomes; exact bytes only for AVAILABLE. WS7 public API smoke returned 3/3 PASS. No route or peer authentication. |
| ArtifactManifestV1 canonical cross-language golden vector | IMPLEMENTED / TESTED | Shared fixture checked by Rust integration tests and independent Node serializer; session DTO parity remains separate. |
| ArtifactReadPort request/observation golden vector | IMPLEMENTED / TESTED | Rust+Node byte-exact request, AVAILABLE and NOT_FOUND fixtures; negative tests cover unknown/duplicate/oversized metadata and host/observation binding. |
| Node ↔ Rust session/public-contract semantic parity | NOT PROVEN | Node role permissions differ from Rust draft permissions; producer/session identity mapping and session DTO golden fixtures need owner review. |
| W3/W2 session claim/owner-epoch and authoritative session time binding | DRAFT / BLOCKED | WS3 supplied exact claim/nested message field inventory but did not ratify; claim_id/owner_epoch/lease/worker binding, W5 session ID/time source and Control pre-send ACL/lease fence remain unresolved. |
| W4 provider artifact lineage packaging | IMPLEMENTED / TESTED; WS4 ACCEPTED WITH BLOCKERS | W5 stores exact response + W4-owned canonical sidecar + optional opaque Governance receipt as two/three refs in one manifest; W4 schema/fixture validator 2/2 plus two negative tests; W5 integration 1/1 test passes. Provider/trust authority not claimed. |
| W6/W7 provenance and evidence trust integration | NOT PROVEN / WS7 ACCEPTED WITH BLOCKERS | WS7 accepted local read semantics only and public API smoke 3/3; completeness, generation, freshness, producer completion and evidence VERIFIED remain external. WS6 trust review not received. W5 proves local byte integrity only. |
| W8 wire/API integration and host-level caller authorization | BLOCKED | W8 logical contract and common envelope are DRAFT/NOT RATIFIED; no approved remote service client, authenticated read route or peer-auth proof. 32 MiB object vs 1 MiB MCP frame requires W8/Execution bounded transfer design. Three-deployable boundary unchanged. |
| Independent Execution deployable and production acceptance | NOT PROVEN | Owner sign-off, identity/auth integration, persistence/backup/restore and release evidence absent. |
