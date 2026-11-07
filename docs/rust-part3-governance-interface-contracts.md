# Rust Part 3 — Governance & Interface Contracts

Status: implementation foundation, **not production-ready**. This document records the current Rust contracts and the missing deployment evidence. It does not supersede approved architecture decisions or the normative AGG checkpoint v2 specification.

**Current validation pointer (2026-11-07):** the workspace-wide test/Clippy discrepancy and cross-workstream integration status are tracked in the [repository status snapshot](STATUS_2026-11-07.md). This contract document's implementation descriptions do not establish production trust provisioning, three-deployable database separation, external checkpoint authority, or rollout approval.

## Governance application service

`runalith-trust::governance_service::GovernanceService` accepts a versioned Control request, authenticates the caller before invoking its backend, parses the supplied evidence bytes using the strict checkpoint JSON parser, canonicalizes the evidence, and compares the resulting SHA-256 with the authenticated request. The backend signs the receipt while its decision transaction remains open; receipt, decision and committed event are persisted atomically.

The service depends on two explicit host boundaries:

- `GovernanceAuthenticator` authenticates the calling Control identity and signs the exact receipt.
- `GovernanceDecisionBackend::evaluate_and_commit` verifies the signed policy and quorum through a transaction-aware verifier, atomically consumes reviewer nonces, signs the receipt, and persists the decision, receipt and committed event.

`runalith-store::StoreGovernanceDecisionBackend` is the concrete **single-file D-01 compatibility adapter** implemented against the 2026-10-30 design decision. It uses the combined workflow Store writer connection and `BEGIN IMMEDIATE`; the injected verifier receives that exact transaction for candidate binding, trust high-water, reviewer registry and nonce operations. Exact idempotent replay revalidates signatures and prior nonce records, compares the immutable outcome and receipt, and validates the committed event's request, idempotency, evidence, receipt digest and decision bindings; it never signs a second receipt. Changed request/evidence under an existing idempotency key fails closed. The historical schema-v18 migration adds the signed receipt column; the current combined Store schema has since advanced to v20. Tests cover atomic receipt/event persistence, exact replay across independent Store connections, idempotency conflicts, receipt/event tampering and rollback of verifier nonce writes when signing fails. This adapter is not accepted as the ADR0003 three-database production topology while the conflicting architecture records remain unreconciled.

`runalith-runtime::TrustGovernanceDecisionVerifier` composes the existing Ed25519 policy/maker/checker verifier with transaction-scoped Store trust and reviewer reads and a host-owned current-candidate subject resolver. This is a concrete verification implementation, not a provisioned host authority. No production Control authenticator, receipt signing key, organization trust roots, reviewer identities, current-candidate resolver or Governance service host is present. A backend that stores decisions separately from the canonical D-01 database does not satisfy the approved consistency contract.

## Trust and identity lifecycle

`runalith-trust::trust_lifecycle` provides `TrustProvisioningService`, `TrustAdministratorVerifier`, and `TrustConfigurationRepository` contracts. The service loads the current configuration from authoritative persistence itself; callers cannot supply a fabricated previous version. Validation rejects skipped/reused versions, provider/domain/scope changes, reused configuration fingerprints, rewritten or extended existing key validity, removed root tombstones, unrevocation, malformed SPKI fingerprints/PEM, invalid UTC timestamps, and revoked roots that are still marked available.

The same module defines `ReviewerLifecycleService`, `ReviewerAdministratorVerifier`, and `ReviewerIdentityRepository`. Registration requires administrator authentication, a public-only Ed25519 key whose SPKI fingerprint matches, explicit role/domain scope, expiry, and a change-control reference. Reviewer subject, key ID, administrator subject and change reference are bounded and reject ASCII/Unicode control characters before persistence. The service loads current reviewer identity from the repository before a CAS transition; subject, key, role, domains and registration time are immutable. Suspension may be reversed by an administrator; revocation is terminal. Self-registration and unknown domains are rejected. `Store` is the concrete same-file D-01 compatibility repository; no production administrator verifier or host composition of the lifecycle service is wired.

`runalith-store::governance_persistence` now implements both repository traits directly for `Store`. Lifecycle reads/writes use a dedicated connection to the same physical workflow SQLite file, with `BEGIN IMMEDIATE`, authoritative current-row reads, expected-version CAS, and immutable version tables with SQL UPDATE/DELETE rejection. This Governance writer connection must never be acquired while a workflow writer transaction is held. Approval does not use it: transaction-scoped trust high-water and reviewer reads use the active workflow transaction. The repository repeats transition validation inside the write transaction, verifies persisted trust fingerprint/provider/version bindings and reviewer status/key/version bindings on reads, and rejects terminal-revocation reversal. The additive v9→v10 migration creates the trust-root and reviewer-history tables. Tests cover cross-connection CAS races, repository round trips, tamper-binding checks and terminal revocation. This is current same-file compatibility persistence, not evidence that the target three-database topology has been implemented.

This is concrete persistence for the current same-file D-01 compatibility topology, not proof that the unresolved ADR0003/Option B target has been implemented. `TrustConfigurationObserver` reads exact high-water version/fingerprint/provider from the active workflow transaction and rejects non-transactional inspection. `Store::current_reviewer_in_transaction` reads the current reviewer identity through that same transaction without acquiring the Governance writer connection. `verify_approval_policy_in_transaction` and maker/checker verification use the observer; `TrustApprovalVerifier::with_governance` composes it with the Store reviewer repository and requires every maker/checker to match an active, unexpired identity, role, domain and trust-root fingerprint. Runtime tests prove all five trust domains are checked inside the approval transaction and missing/mismatched reviewer authority blocks approval. The legacy `TrustApprovalVerifier::new`/standalone `TrustLedger` path remains for compatibility and tests; it is not the production three-part composition.

The decision backend and transactional verifier now exist, but the lifecycle services are not composed into a production administrator provisioning path. No organization trust roots, reviewer identities, Control authenticator, receipt signing key, current-candidate resolver or service host are provisioned. The durable Governance decision/receipt/nonce unit is atomic inside the compatibility Store transaction; a later Control workflow approval transition is still a separate transaction and is not claimed as one cross-service atomic transition.

## External checkpoint custody

`runalith-agg::custody` defines authority operations (`prepare`, `finalize`, `abort`, `operation_status`, `head`, `checkpoint`, `outstanding_operations`), operation receipt verification, attestation verification, approved projection-digest verification, and durable nonce-ledger contracts.

The local saga contract persists intent before network I/O, records remote reservation, applies the projection mutation and `ANCHOR_PENDING` atomically, records an anchor only after exact projection read-back, and quarantines ambiguous outcomes. The D-01 transition gate is a fenced durable lease; a process-local mutex is insufficient.

`verify_checkpoint` returns `UNKNOWN` if the approved projection digest verifier, independent attestation verifier, or durable nonce ledger is missing. It rejects changed database identity, broken predecessor sequence, mismatched audience/operation/challenge, expired/revoked attestations, invalid receipts, and replay. Digest verification is injected because the normative projection manifest and exact checkpoint envelope remain authoritative; this module does not invent their domain labels or component inventory.

`runalith-store::checkpoint_persistence` now implements `AttestationNonceLedger`, `SecurityProjectionTransitionGate` and `CheckpointOperationRepository` over the same combined workflow Store connection. The durable local gate uses `BEGIN IMMEDIATE`, owner/fencing-token CAS and refuses takeover while operations are unresolved. Operation intent, authenticated PREPARED/ABORTED receipts, state transitions, append-only events and store-wide quarantine are persisted with fencing checks. Recovery readback recomputes the canonical request digest, cross-checks every denormalized identity/nonce/generation/manifest/expiry column against immutable request JSON, validates state/receipt consistency and timestamps, and requires the latest append-only event to match the current state and fencing token. `list_operations_with_verified_authority_receipts` independently verifies every persisted authority receipt through the injected verifier. Nonce consumption is one-time and cross-connection serialized. Once quarantined, new gate acquisition, gate renewal, intent persistence, remote reservation, abort-receipt transitions, nonce consumption, trust/reviewer lifecycle writes and Store workflow/catalog/session/provider/graph mutations fail closed across logical database IDs; only terminal gate release remains available to relinquish a lease after the quarantine transition itself. Tests cover replay, tamper rejection, receipt verification, fencing, unresolved-operation takeover denial, cross-logical-database mutation denial after store-wide quarantine, explicit denial of trust-configuration/reviewer registration writes after quarantine, and explicit schema migration. These ledgers first shipped in schema v18; the current combined Store is schema v20. This persistence does not resolve the production database ownership conflict or provide the required external authority.

This is local custody infrastructure, not a completed external checkpoint saga. `apply_projection_and_mark_pending` and `record_anchored_if_projection_matches` deliberately fail closed because the approved v2 projection manifest, complete authorization writer inventory, transactional mutation descriptor and current-state equality proof are unavailable. The local gate is SQLite-durable but is not yet proven as a host-enforced global writer barrier across every process/connection that can mutate projected state. External authority, attester, independent verifiers, continuity/head and complete outstanding-operation evidence remain absent.

No external checkpoint authority, attestation chain, receipt key, approved projection manifest, complete writer inventory, or host-enforced global transition barrier is present. The local operation repository and gate cannot establish external checkpoint continuity by themselves. Therefore no external checkpoint is asserted as production `VERIFIED`.

## AGG snapshot evidence byte integrity

`runalith-agg::evidence_integrity` now exposes caller-resolved byte-integrity primitives. `compare_source_bytes` validates one `GraphEvidence` record and hashes the exact supplied bytes, with a fixed 64 MiB per-source bound. This is an explicit Rust bound; the current Node verifier receives source records from an injected resolver, so equivalent end-to-end Node source-size parity has not been established. `compare_graph_evidence_manifest` requires exact `(node_id, source_uri)` binding coverage: missing, extra, duplicate, or node-misbound evidence records fail closed. A shared URI may be resolved once while each referencing node still requires its own evidence record; output entries retain both node and evidence identities. Digest mismatches remain explicit non-authorizing results. `compare_snapshot_evidence_manifest` additionally validates the immutable `GraphSnapshot` digest and requires the supplied AGG graph to match the snapshot's node/edge projection for its supplied start/goal IDs before checking one resolved byte sequence per pinned evidence URI.

These functions do not resolve `artifact://` or `file:` URIs, authenticate the source adapter, establish artifact producer lineage or source durability, verify claim truth/independence, or upgrade `GraphEvidence::verification`. The snapshot schema does not itself pin the AGG start/goal selection. An empty evidence manifest is reported as `empty`, not as verified. No production source resolver or MCP/Store caller is wired to these functions yet; production evidence verification remains open.

The byte-integrity entry point additionally rejects malformed verifier identities when an evidence record claims `Verified` or `Rejected`: the identity must be non-whitespace, trimmed, at most 256 bytes and free of control characters. This is a format/integrity guard only. It does not authenticate the verifier, validate the receipt signature, establish freshness or provenance, or change the evidence verification status. The regression `verified_evidence_requires_a_bounded_non_whitespace_verifier_identity` covers whitespace-only, padded, control-character and oversized identities.

## Independent evidence-verification receipt v1

`runalith-protocol::evidence_verification_v1` now defines the closed typed
`EvidenceVerificationReceiptV1` and `EvidenceVerificationSubjectV1` contracts
for the Node `adaptive_goal_verified_knowledge_graph_attestation` schema. The
subject binds the goal ID, immutable snapshot hash, sorted node/edge/membership
inventories and normalized evidence-manifest hash. The receipt binds those
same values plus provider ID, configured trust-root SHA-256, one-use UUID nonce,
canonical issuance/expiry timestamps, `agg.goal_idea_graph.verify` scope,
independent claim/independence status and Ed25519 signature. The typed claim
decision is explicitly `Verified` or `Rejected`; both are terminal signed
decisions and require the complete receipt, configured verifier identity and
durable nonce consumption. `Unverified` and `Unavailable` are not receipt
decisions and must remain receipt-free states. A digest match alone never
changes either state. Unknown fields,
malformed/noncanonical inventories, mismatched subjects, expired/future-dated
receipts and validity windows longer than thirty minutes fail closed. Its
`canonical_sha256()` covers the complete canonical receipt including signature;
`attestation_id()` matches the Node durable attestation identity formula.

The trust verifier does not accept a caller-supplied verifier name as authority:
it derives `verifier_id` from the configured provider and the exact public-key
ID selected by successful Ed25519 verification. It returns a
`VerifiedEvidenceVerificationReceipt` only after signature, exact receipt digest,
snapshot/manifest binding, explicit trust high-water observation and the
Governance nonce-ledger port all succeed. Stable failure classes distinguish
malformed/stale/replayed data (`Invalid`), unprovisioned verifier or nonce
storage (`Unavailable`), and disallowed trust-root/configuration (`Unauthorized`).

The Node Goal/Idea verifier now accepts both signed terminal claim decisions:
`claim_status=verified` is exposed as `status=verified`, while
`claim_status=rejected` is exposed as an authenticated `status=rejected` report
with `receiptVerified=true`, `claimRejected=true` and `verified=false`. The
general authenticated-decision predicate recognizes either current terminal
decision; the stricter authenticated-verification-report predicate accepts only
the Verified decision and remains the sole Plan Graph projection gate. A
Rejected receipt is persisted, exact-replay idempotent, nonce-bound and terminal
for that snapshot; a different receipt cannot replace it until a new immutable
snapshot exists. Expired decisions cease to be current. This keeps a genuine
negative independent finding distinguishable from missing, unavailable or
malformed verification without turning rejection into execution authority.

`runalith-trust::evidence_verification::verify_knowledge_graph_evidence_receipt`
composes that contract with the existing observed trust-root and Ed25519
envelope verifier. It checks exact receipt digest/root/nonce bindings, derives
verifier identity from the configured provider and verified key ID, and only
returns `VerifiedEvidenceVerificationReceipt` after durable nonce consumption.
The new `EvidenceVerificationNonceLedger` port requires an atomic persistent
nonce binding to receipt and subject digests. A first binding is consumed;
repeating the exact same nonce, receipt digest and subject digest is an
idempotent replay of the same authenticated decision. Reusing the nonce for
different receipt or subject bytes is rejected as `Invalid`
(`KNOWLEDGE_ATTESTATION_NONCE_REPLAY`). A missing/unavailable ledger returns
`Unavailable` (`KNOWLEDGE_EVIDENCE_NONCE_LEDGER_UNAVAILABLE`). Trust/root/authority
failures classify separately as `Unauthorized`. There is deliberately no
production nonce-ledger adapter in this change; the positive replay test uses
only a process-local test fixture.

The receipt contract tests cover exact snapshot/manifest binding, sorted
inventories, independence status, validity windows, unknown fields and stable
attestation identity. Trust tests now also exercise positive Ed25519 signatures
for both Verified and Rejected decisions, exact verifier-key identity, receipt
digest, snapshot/manifest binding, byte-identical idempotent replay and
different-payload nonce conflict. Those keys and the nonce ledger are ephemeral
test fixtures only. A separate Node-generated Ed25519 knowledge-attestation
fixture now lives at `tests/fixtures/knowledge-attestation-v1-node.json`.
`tests/test-knowledge-attestation-node-fixture.mjs` rechecks the Node canonical
payload, public-key fingerprint, signature, full receipt digest, subject digest,
and attestation identity; the Rust trust test independently verifies those
same bytes through the observed trust-root and nonce-ledger interfaces, including
exact replay. The fixture key is test-only and does not provision a production
signer. Production `GraphEvidence` status transition remains open. The trust
module does not create signing keys, trust roots, durable nonce-ledger adapters
or reviewer authority.

## Authenticated evidence-source resolution v1

`runalith-protocol::evidence_resolution_v1` defines strict request, response and
producer-lineage contracts for a future Governance-to-Execution read-only
source call. Requests bind a unique request ID, Governance requester, expected
Execution audience, evidence/node identities, durable URI, pinned SHA-256 and
maximum byte count. Responses bind back to the exact request and include the
authenticated responder identity, caller audience, media type, byte count,
source SHA-256 and availability. `file:` references follow the Node
content-addressed form `file:<relative-path>#sha256=<lowercase-sha256>`; absolute,
traversal, unpinned or differently pinned paths are rejected by the protocol
contract. Parsing either supported URI scheme is not proof of source
authenticity or retrievability.

For `artifact://`, the response requires an exact producer lineage record with
job, artifact and artifact-created event IDs; producer role, task, attempt,
completed task status, successful result and completion event; producer
contract/result-lineage digests; content digest and schema version. The explicit
`producer_attempt_id` strengthens the cross-part contract. The current Node
resolver exposes a boolean `producerResultLineageValid` plus task/result/event
identities but not this typed attempt field, so Rust/Node producer-lineage
semantic parity remains unproven until Execution publishes the authoritative
attempt-bound response contract.

`runalith-agg::evidence_resolution` adds the Governance-owned
`AuthenticatedEvidenceSourceResolver` seam and `GovernanceEvidenceResolver`
composition. Before transport, it validates that request audience equals the
host-configured Execution service identity and passes that expected identity to
the adapter. The adapter contract requires authenticating the remote peer and
performing only a read-only owner-service lookup; it must not open Execution's
database or artifact filesystem directly. `GovernanceEvidenceResolver::resolve`
returns only an opaque `EvidenceSourceResolutionIntegrity`, not the caller's raw
transport result. The private integrity constructor binds the exact canonical
request digest, original byte limit, authenticated peer identity, response
identity, producer lineage, measured byte count and recomputed SHA-256. The
manifest builder accepts only these opaque integrity results and rejects a
result rebound to a weaker/different request. Stable classifications
distinguish unavailable sources, invalid metadata/bytes and unauthorized peers.
The returned integrity report is non-authorizing; it never sets
`GraphEvidence::verification` to `Verified`.

`build_snapshot_evidence_resolution_requests` validates a sealed
`GraphSnapshot`, creates a deterministic request per unique source URI, and
rejects one URI pinned to conflicting source digests. Shared URIs are resolved
once. `canonical_evidence_resolution_manifest_sha256` reproduces the Node
normalized artifact/file record shape and SHA-256 (including an independent
Node-generated golden manifest hash); it reports the empty manifest hash but
keeps it ineligible for attestation. `evidence_verification_subject_from_snapshot`
then checks exact evidence-source coverage/digests and derives the signed
subject from the immutable snapshot's hash, node IDs, edge IDs, host-supplied
membership IDs, Goal ID and normalized manifest hash. Membership provenance
and Goal-to-snapshot ownership must be supplied by the authenticated host; this
function does not invent either fact.

`resolve_snapshot_evidence_for_attestation` now orchestrates the complete
Governance-owned preparation path over that resolver: it derives the bounded
requests from one sealed snapshot, resolves every unique source through the
injected authenticated Execution adapter, rejects the whole operation on the
first unavailable/unauthorized/invalid result, builds the normalized manifest,
and returns the exact verifier subject. Its result type exposes only requests,
the opaque integrity manifest and the bound subject. It does not sign a receipt,
write verification status, or grant planning authority. Regression tests prove
the one-source happy path, canonical membership ordering, exact snapshot and
manifest binding, that source claims remain `Unverified`, and that an adapter
whose authenticated peer differs from the host-pinned Execution identity is
rejected. The test adapter is a fixture, not a remote service or production
credential.

The full orchestration API is therefore **IMPLEMENTED** at the port/algorithm
boundary, while the source-owner adapter and cross-process path remain **NOT
DEPLOYED**. There is no production Execution service identity/credential,
authenticated transport adapter, durable source resolver, or Governance host
composition in this workspace. In addition, the current Node resolver exposes
`producerResultLineageValid` plus task/result/event identities but not the typed
`producer_attempt_id` required by this Rust contract; semantic parity and the
authoritative attempt-bound contract must be confirmed by the Execution owner.
Until Execution supplies the authenticated read-only response and durable
producer-attempt lineage, the result cannot be consumed as independently
verified evidence; claim status remains `Unverified`/`Unavailable` and no
independent verification claim is made.

The MCP interface additionally exposes the Rust-native `graph_snapshot_get`
read tool. It accepts a `graph_id` and optional positive safe-integer `revision`
(omission selects the latest snapshot), delegates to the existing
`Store::get_graph_snapshot`, and returns the persisted immutable snapshot with
explicit `read_only`, `snapshot_created=false`, `execution_authorized=false`
and `dispatch_allowed=false` fields. Evidence verification states are retained
as sealed; the tool does not replace them with a summary assertion. After Store
has validated the exact persisted digest, database/payload identity and
predecessor hash, the MCP response applies the established recursive secret
redactor and sets `snapshot_payload_redacted=true`. The returned
`snapshot_sha256` identifies the stored pre-redaction payload and is not
recomputable from the redacted projection. Missing graph/revision and unsafe
revision values fail as tool errors; no new snapshot or graph revision is
created. This is deliberately not advertised as Node semantic parity: Node's
`adaptive_goal_knowledge_snapshot_get` requires a `goal_id`, whereas the Rust
storage contract is keyed by `graph_id` and optional snapshot revision. It also
does not upgrade any evidence verification state. Before returning a success
response, `handle_frame` serializes the complete JSON-RPC envelope exactly once
(including the actual request ID and modern server metadata), checks the
resulting byte length, and rejects this read-only operation with a bounded
`-32603` error if it exceeds the 1 MiB MCP frame limit. The same serialized
bytes are emitted when within bounds, avoiding a serialize/clone/serialize
sequence for large snapshots. This prevents the duplicated
`structuredContent`/text tool result from emitting an oversized frame. The same
1 MiB cap applies to every successful MCP response. If a mutating handler has
already returned successfully but its response cannot fit, stdio emits a
bounded `MUTATION_OUTCOME_UNKNOWN` response bound to the original request ID,
requires durable-state reconciliation and forbids automatic retry; it does not
report a possibly committed mutation as a definite failure. `protocol_error`
also bounds serialized error responses; oversized messages or `data` are
replaced by a small request-ID-bound `-32603` envelope without attacker-sized
diagnostic content.

## MCP service boundary

`runalith-protocol::mcp_service_v1` defines a transport-neutral request/response envelope with strict fields, authenticated principal context, capability ID, operation type, explicit side-effect class, and mutating idempotency key. Read-resource, prompt, and capability-discovery requests cannot claim mutating effects. Request/correlation IDs, principal identity/context, capability, operation name and mutating idempotency key reject embedded control characters in addition to empty/oversized values; response service/request identity and safe error code/message receive the same control-character check. This hardens the existing v1 validator without changing its serialized schema or version.

Governance approval request/subject/receipt text fields now also reject embedded
ASCII and Unicode control characters before authentication or binding decisions
are consumed. Receipt reviewer-subject identities are also bounded to 256 bytes
and reject control characters; the same constraints are enforced on the
backend's decision result before a receipt is signed. The public MCP response `validate_for` operation validates the
originating request first, so a response cannot be treated as validated when its
request envelope itself violates the published schema. `Unknown` is restricted
to a mutating request with a non-empty idempotency key and the stable
`MUTATION_OUTCOME_UNKNOWN` code; read-only calls and unrelated service errors
cannot masquerade as ambiguous writes. Regression tests cover control-character
routing/subject injection, missing mutation idempotency and the exact UNKNOWN
classification. The v1 wire shape is unchanged.

`runalith-mcp::service_gateway::McpGateway` depends only on `McpApplicationService`, not Runtime or Store. Its `handle` method now requires an `AuthenticatedMcpTransportContext` as a separate argument alongside the versioned request. The context carries a bounded/control-free connection ID and authenticated peer identity constructed by the host only after it verifies the actual accepted transport; it is not deserialized from caller JSON. `McpTransportPrincipalAuthenticator::authenticate` receives both the host transport context and the request principal and must bind them. This closes the earlier interface weakness where an authenticator received only caller-supplied principal claims and was expected to infer connection state. The Gateway authenticates before request validation or service access, checks the principal audience, authorizes capability discovery and every invocation, separates read-only and mutating methods, checks capability metadata uniqueness/safety, and rejects response identity mismatch. Before authorization or dispatch, it calls the service-owned `expected_side_effect_class` route-registry lookup with the exact versioned request and rejects a mismatch with `SideEffectClassMismatch`. The service must derive this value from its own tool registry/schema; it must not echo the caller's `side_effect_class`. The application-service authorization callback receives the complete request, not only the principal/capability/operation summary, so the owner can bind the exact tool/resource/prompt name, arguments, capability, idempotency identity and resource scope. Neither caller claims nor Gateway capability metadata are an authorization grant. Protocol requests and responses have a fixed 1 MiB envelope limit. Regressions prove an authenticated transport peer/connection mismatch is rejected even when the request principal is otherwise correct, caller attempts to downgrade a mutating tool to read-only or upgrade a read tool to mutating are rejected before authorization and invocation, authorization denial prevents invocation, and read-only routing never calls the mutating API.

Capability discovery also rejects IDs containing Unicode control characters,
including CR/LF and NUL, in addition to blank, oversized and duplicate IDs.
`capability_discovery_rejects_control_characters_in_capability_ids` verifies
these malformed catalogs fail with `InvalidCapabilities` after service-side
authorization and before any catalog can cross the gateway boundary.

After a mutating invocation begins, a service transport error or an invalid/misbound
response cannot prove that the mutation did not commit. The Gateway now returns a
request- and service-bound `McpServiceOutcome::Unknown` with stable code
`MUTATION_OUTCOME_UNKNOWN` instead of surfacing a client failure. The message
requires durable-state reconciliation before retry; it does not retry or claim
that the mutation committed. Regressions cover a simulated connection loss after
commit and a response with a mismatched request ID. Read-only invocation errors
retain their ordinary failure path because they do not have mutation ambiguity.

The stdio host now derives `tools/call` name admission from the same
`tool_definitions()` catalog used by `tools/list`; it no longer maintains a
separate hard-coded name allow-list. This closes the observed drift where eight
advertised recommendation/policy tools were rejected as unknown by the wire
dispatcher. `every_listed_tool_has_a_stdio_dispatch_route` probes every
registered name with an invalid closed-schema argument and confirms it reaches
tool validation without invoking its handler; a companion negative test keeps
unregistered names rejected. This is a route-consistency guard, not per-tool
Node semantic-parity evidence.

The stdio lifecycle also treats a valid JSON-RPC `tools/call` without an `id` as
a notification, not as a request: it returns no response and never calls the
tool handler. Regression `tools_call_notification_without_request_id_never_mutates_workflow_state`
sends a valid workflow-create payload without an ID, then reads the durable
workflow list and confirms no proposal was created. This preserves attributable
request/response identity for mutations and matches the pinned Node host's
notification suppression behavior.

The production `runalith-mcp` stdio binary is now composed through `McpGateway` rather than dispatching application operations directly. At startup it reads the parent PID/effective UID from kernel-provided `/proc` status, requires the parent effective UID to equal the MCP process effective UID, and constructs a separate `AuthenticatedMcpTransportContext` and `McpPrincipalV1` with issuer `linux-stdio-parent-process`, audience `runalith-local`, and a per-process/parent connection identity. The authenticator binds the context and principal before request validation, capability discovery or service access. Capability discovery rejects catalogs above 256 entries, non-canonical/oversized IDs, duplicate IDs and unsafe operation/effect combinations before serialization; the MCP frame limit remains an independent second bound. Sandbox environment switches, required absolute paths, executable-root lists, timeout/output bounds, allowed environment keys, cgroup resource ceilings and artifact-store path are validated before workflow Store initialization. Bubblewrap/cgroup enforcement and the artifact store are composed before the workflow database is opened or created, so invalid/unavailable required sandbox composition cannot leave a newly created workflow database behind. The data directory must be absolute, non-root and traversal-free; existing path components are checked for symlinks before and after creation. These path checks do not turn same-UID local IPC into protection against a hostile process running as the same OS user. This is **local single-OS-user process identity only**; it is not a remote end-user identity, Control credential introspection, mTLS identity, or multi-user authorization. The host fails to start if the OS parent identity cannot be read or is under a different effective UID.

The local application-service adapter still wraps the in-process `WorkflowService`/Store for the compatibility topology, but every stdio application route (`tools/list`, `tools/call`, resource list/read, prompt list/get) is routed through Gateway authentication, service-owned capability discovery, exact-route authorization and side-effect-class validation. `serve_stdio` refuses to run when no authenticated Gateway context has been composed, so its transport entrypoint cannot silently fall back to direct dispatch. The local Gateway exposes only a 14-tool security-reviewed read-only allowlist, plus resources and prompts. The allowlist is independent of public `readOnlyHint` annotations: `workflow_recovery_quarantine_expired` and `workflow_provider_reconcile` are explicitly excluded because they can mutate durable or external state despite currently being annotated read-only. Tests prove these names are not advertised and direct attempts are rejected.

**All mutating stdio routes are intentionally disabled** until the owning Store/Control service supplies a durable generic MCP idempotency adapter and replay/UNKNOWN reconciliation contract. The Gateway does not substitute a transient JSON-RPC ID for a durable key; a mutation attempt fails before service handler invocation with `MUTATION_IDEMPOTENCY_UNAVAILABLE` and `handler_invoked=false`. This is fail-closed local integration, not a production multi-service Gateway deployment. Raw `McpServer::handle_frame` is now private to the crate; the only public transport entrypoint is `serve_stdio`, which refuses to start without the local Gateway builder. Unit tests may still exercise the private frame parser inside the crate, but there is no public raw-frame dispatch API that bypasses host authorization. The host does not have remote Control or Execution clients, credential-to-principal mappings, or independent service processes. Its JSON-RPC response path still enforces the 1 MiB frame cap for every successful and error response; oversized diagnostics become bounded request-ID-bound `-32603`, and request IDs are bounded to 128 UTF-8 bytes and control-free.

The Part 1 `runalith-control-api` library exposes versioned `/v1` routes for workflow list/create/read, catalog, policies, approval/admission/cancellation, coordinator claim, recovery and worker-facing operations. Every request is authenticated by host-injected `ControlPrincipalVerifier`; the resulting principal contains subject, issuer and route capabilities, and each route enforces its own capability before touching `WorkflowService`. The HTTP parser bounds headers/body, rejects ambiguous framing and only serves loopback listeners. This is a library API with source-level route tests, not a standalone application/process or independently owned database. The existing Worker HTTP client targets Worker routes and is not an MCP Control client. No MCP-to-Control HTTP adapter exists, and there is no `/whoami`/identity-introspection response to bind a remote bearer credential to the authenticated MCP principal. The local stdio Gateway above does not invent this remote binding; it deliberately uses a weaker but explicit local OS UID trust domain and has no cross-service client. A remote Gateway deployment still requires a host-provisioned credential-to-principal binding contract plus independently hosted Control and Execution APIs. A corresponding independent Execution application API is absent. Process isolation, complete modern/legacy parity, and the remaining Node MCP tools are not implemented by this contract alone.

## Architecture decisions and blockers

- **D-01 / ADR0003 architecture is internally inconsistent and must be reconciled by the decision owner.** ADR0003 (accepted 2026-11-01) and the current `rust/THREE_PART_IMPLEMENTATION_PLAN.md` select three separately owned deployable databases (Option B), with Governance authoritative for canonical trust/reviewer/nonce/decision state and only a minimum authenticated approval-high-water projection in Control. In contrast, `docs/agg-external-checkpoint-v2-decision-register-20261030.md` §11.3 records the Project Owner's 2026-10-30 approval of a single physical SQLite database for workflow and trust-ledger rows, and §11.4 limits that decision to specification/documentation work. Those are incompatible data-ownership assumptions; the later ADR/plan do not themselves record an explicit supersession of §11.3. No runtime change may infer which decision wins. The Project Owner/architecture maintainers, with Control and Governance data owners, must publish one superseding versioned decision that explicitly reconciles these records before any DB ownership/cutover work.
- **D-01 decision acceptance evidence:** a single normative ownership matrix and migration decision; exact tables/columns/records owned by each part; exact definition and authentication of any Control-side high-water projection; freshness and revocation race semantics; durable outbox/inbox and replay/conflict semantics; complete authorization reader/writer inventory; global writer barrier/fencing authority (not merely a Control-process advisory lock); logical DB identity/generation/restore epoch; bounded busy/WAL durability policy; source/target schema and row digests with exact readback; crash/restore/clone/fork tests; and recoverable cutover/rollback retaining the legacy database as an immutable verified archive. Until then, the existing same-file Store adapter is only compatibility implementation and neither a production Governance-owned database nor proof of Option B. No second database has been created and no production DB mutation is authorized.
- **D-05/D-06 remain independent deployment prerequisites.** D-05 requires a real identified attestation chain and independent verifier appraisal. D-06 requires an independently administered authority with durable prepare/finalize/abort/status/head/outstanding-operation semantics and exact idempotency. The current local fenced SQLite repository is not that authority; missing authority/attestation remains UNKNOWN, never VERIFIED.
- **Cross-part owners and acceptance criteria:**

  | Boundary / owner | Current implementation | Required owner contract and acceptance evidence | Status |
  |---|---|---|---|
  | Control → Governance approval; Control owner + Governance owner | `GovernanceApprovalRequestV1`, signed `GovernanceApprovalReceiptV1`, injected caller authenticator/signer/backend and transactional test adapter exist. Request authenticator is capped at 16 KiB; evidence raw bytes follow the shared strict JCS 1 MiB limit; receipt serialization is capped at 32 KiB. Reviewer subjects are unique, bounded, trim-stable and deterministically sorted before signing. | Exact canonical request/receipt binding to Control candidate, immutable plan, source snapshot, action scope, workflow/task context and evidence digest; authenticated issuer/audience and signing-key identity; independent Control-side signature/binding verification; expiry/freshness/revocation; nonce/idempotency replay; durable outbox/inbox; and an explicit Control approval-transition acknowledgement/transaction rule. Must have cross-process tests for duplicate, delayed, tampered and unavailable responses. Backend must reject an oversized receipt inside its transaction before committing nonce/decision records. | Contract foundation only; no production credentials, signer, independent Governance host or Control HTTP adapter. |
  | Governance → Execution evidence lookup; Execution owner + Governance owner | Versioned authenticated-resolver port and strict request/response, byte-hash and producer-lineage contracts exist. Snapshot resolution has a 2,048-reference cap, a 64 MiB per-source cap and a checked 256 MiB aggregate-source-byte budget. Exact source bytes and response metadata are bound to host-pinned Governance/Execution identities; resulting manifest is preparation material only. | Execution-owned read-only endpoint and authenticated peer identity; exact artifact bytes, SHA-256, media type and length; producer workflow/task/attempt/lease/owner-epoch/plan/result/event lineage; stable stale/missing/ambiguous/error semantics; and owner-published Node/Rust-compatible attempt-bound producer contract. The current Node-facing evidence shape only exposes `producerResultLineageValid` plus task/result/completion-event identities; Rust v1 also requires `producer_attempt_id`, `producer_contract_sha256`, and `producer_result_lineage_sha256`. A boolean cannot be promoted into these independent bindings. Execution must publish the authoritative field derivation and a Node/Rust cross-runtime golden fixture. Must pass separate-process identity, tamper, stale and replay tests without opening Execution DB/filesystem from Governance. | Port only; no authenticated Execution adapter/host; producer-attempt semantic parity remains open. |
  | D-01 data ownership/cutover; Project Owner/architecture + Control and Governance owners | Same-physical-file Store compatibility adapter and local D-01 transactional tests exist. | One superseding decision reconciling ADR0003/Option B with decision-register §11.3, then the full evidence set in the D-01 acceptance criteria above. | Conflicting architecture records; blocked pending explicit owner reconciliation. |
  | Governance host, trust provisioning and nonce authority; Governance/platform owner | Trust lifecycle, approval/quorum verification, receipt signing, evidence receipt verification and nonce ports exist. `TrustConfiguration::validate_integrity` checks static domain/scope, bounded canonical administration identities, JavaScript-safe versions/timestamps, shared root key-ID grammar, PEM↔parsed Ed25519 key↔SPKI/legacy fingerprint equality, unique roots, canonical validity/revocation timestamp bindings, availability snapshot consistency, and the recomputed canonical fingerprint of every top-level/root field. This guard runs on TrustSet observation, signed-envelope verification/root lookup, legacy ledger record/inspect, lifecycle transitions and the D-01 Store observer. Provisioning retains immutable key tombstones and caps signed admin instructions at 16 KiB. Reviewer identities are host-authenticated, bounded and immutable; expired reviewers can be revoked without extending key validity. | Standalone host composition; authenticated Control client identity; out-of-band public trust-root/reviewer provisioning and administrator ceremony; production signer/HSM custody, rotation/revocation/high-water; durable nonce store with atomic exact replay; health/readiness and secret rotation; isolated Governance store and restore/runbook. | Interfaces/validation/regression tests implemented; no `runalith-governance` host or production authority provisioned. |
  | External checkpoint; Governance/platform owner + external authority/attester | Strict custody protocol, local durable fenced operation repository, verifier ports and quarantine behavior exist. Checkpoint verification bounds component inventory to 256 canonical IDs, authority envelopes to 64 KiB, attestation nonce to 64–256 lowercase hex bytes, and operation listings to 4,096 unique bounded IDs; unsafe timestamps/identities/digests fail closed. | Approved projection manifest and complete writer inventory; actual independent attestation chain/verifier; independently administered authority with required durable operations; host-enforced global writer barrier; DB identity/generation/restore epoch; continuity, crash, restore, clone, replay and rollback evidence. | Contract validation implemented and locally regression-tested; external authority and trusted measurement absent; UNKNOWN. |
  | MCP Gateway → Control/Execution; MCP host + respective service owners | **INTEGRATED / VERIFIED (local-only read path):** production stdio now requires `McpGateway`; parent PID/effective UID is verified from procfs before filesystem/Store setup; principal is bound to a separate transport context; exact route auth and an explicit 14-tool read-only allowlist protect tools/resources/prompts. False read-only metadata for provider reconciliation and recovery quarantine is not trusted. All mutations are denied before handler invocation until a durable idempotency contract is supplied. | Remote service host identity/credential-to-principal contract; independently hosted Control and Execution clients; production peer auth (e.g. pinned mTLS or authenticated credential introspection); durable mutation inbox/idempotency and replay/UNKNOWN reconciliation; cross-process timeouts, revocation and error semantics. | Local single-UID stdio integration is implemented and regression-tested; remote Control/Execution Gateway integration and all mutating routes remain NOT DEPLOYED. |

The `agents` Google Chat space contains the contract requests for these boundaries; at the latest inspection it contained project-authored requests and Part 1/Part 2 status notes, but no owner-authored decision/acknowledgement. A request, invitation, silence or project-authored status message is not owner acceptance.

The current workspace does not contain the deployable Governance service host or an independent Execution public API. The Part 1 Control HTTP API is a library/binary compatibility host over the combined Store, not proof of three independent deployables. Current in-process Store adapters persist workflow, trust/reviewer, Governance decision/receipt/nonce and local checkpoint state in the same physical workflow SQLite file; `governance_connection_is_distinct_and_targets_same_wal_database` proves only a second connection to that same file. Do not repair this by creating an unapproved DB or modifying Part 1/2 stores from the Governance package. The production trust-provisioning runbook prohibits redirect/copy/migration until the accepted projection writer inventory, logical DB identity/generation/restore epoch, writer barrier/fencing contract, bounded busy policy, effective WAL/locking readback, schema/row digest/readback, crash/restore/clone tests, recoverable rollback and external monotonic anchor are verified. No production DB mutation is authorized. Production Control authentication, receipt signing authority, trust provisioning, current-candidate resolver, Governance host, authenticated Execution source adapter and atomic coordination with a later Control workflow transition remain open. Local checkpoint state does not establish cross-process writer barrier, complete projection or external continuity.
- AGG Phase 2 now reproduces and validates the exact bounded Phase 1 candidate set before deterministic discriminator ranking. Phase 3 now has bounded deterministic MCTS shadow search. Both are exposed through read-only MCP tools and require a fully validated model v2 input. They remain estimates only: MCTS is non-exhaustive, evidence remains UNKNOWN, and execution/dispatch remain false. Training/evaluation, authoritative membership/evidence verification, checkpoint-linked graph proof, and production execution integration remain missing.

Production readiness requires implementations and tests at these external boundaries, approved manifest and decision changes where needed, full Node differential fixtures, database migration/crash/concurrency coverage, and deployment-specific credentials. No credential or authority is synthesized by the Rust code.

## Verification snapshot — 2026-11-03

- `cargo fmt --all -- --check`: PASS on the final Trust/Store integrity and MCP startup source snapshot.
- `cargo test --workspace --locked --offline`: PASS on the final source snapshot (exit 0). Counts: AGG 60; Artifacts 5; Control API 26 + Control binary 8 + standalone-process integration 11; Domain 33; Execution 4; Execution Persistence 7; Linux Quota 10 + quota integration binary 6; MCP 67 library + 6 binary + 5 CLI/health integration; Protocol 35; Providers 16; Recovery 15; Runtime 24; Sandbox 51; Store 99; Trust 56; Worker 70 + 2 binary. All workspace doc-tests passed with zero failures.
- `cargo clippy --workspace --all-targets --locked --offline -- -D warnings`: PASS on the final source snapshot (exit 0), including every workspace crate; no out-of-scope Clippy blocker remains in this verification run.
- Latest Gateway hardening bounds capability discovery to 256 entries, rejects non-trim-stable IDs and retains the complete MCP frame-size check as a second bound. The oversized-catalog and control/noncanonical-ID regressions pass; the fresh full workspace test run also passes after this change.
- Node/Rust knowledge-attestation golden fixture: Node signature/canonical payload test PASS (1/1); Rust exact-byte verifier test PASS in the Trust workspace suite.
- Focused Node trust/approval/evidence/reviewer/checkpoint/attestation suites: PASS (108/108; last run before this pass, with no Node source changes in this pass).
- `npm run docs:check`: PASS after the final documentation changes (252 Markdown files, 615 local links; 75 registered tools match the MCP reference).
- `node --test tests/test-agg-v2-sql-mutation-audit.mjs`: PASS (13/13) in 102.06 seconds when isolated; it also passed (13/13) in the latest `npm test` grouped run. Its final preserved-query-register test takes 86–111 seconds because it rebuilds caller context for 134 event SQL callsites; this is slow but verified passing.
- `npm test`: **FAIL, exit 1, 35/36 tests in the AGG grouped run passed**. The sole failing assertion is the V2-01 inventory equality at `tests/test-agg-v2-event-callers.mjs:198`; the isolated `node --test tests/test-agg-v2-event-callers.mjs` rerun confirms 8 scanner/parser cases pass and only the final reviewed-register equality fails. The concurrent SQL mutation audit passed all 13 tests in the same full npm run. The current source and reviewed v0.5.17 register differ as follows (full SHA-256 values shown):

  | Source path | Current source | v0.5.17 register | Callsite count |
  |---|---|---|---|
  | `src/runtime/adaptive-goal-knowledge-verifier.js` | `6bdc2e73d0d0eafeff3b4d78a8f849f463368003e235997956eb89d20bf53e6c` | `8d294a8b72280ad72b78808071d9a14f4bcfce736f570f4b6745bf20873671fd` | 0 / 0 |
| `src/runtime/workspace-write-capability-service.js` | `dfedc7f34edc86d4161ec2ede9c69946d2c0e861253902a2d9b80322a839f1be` | `a37dc8da098d515bcb84de1e08a78f499c09edf3670f6bdd0874f62d9845bc09` | 2 / 1 |
| `src/runtime/workspace-write-receipt-store.js` | `bef4db746ab9e396641b23b1403ffb174fdf8dc00edb34745dbc6d27e0cbb3a2` | `5bc8888288b0a741fdf587966c4090e6589146f61b949324fcde0ae6ba4f6e2f` | 0 / 0 |

  The v0.5.17 register/inventory was created on 2026-11-01; the three source paths were modified/added on 2026-11-02. The test's exact comparison establishes stable source/register drift (not a scanner/parser failure): source currently hashes to `6bdc…`, `dfed…`, `bef4…`, while the register pins `8d294…`, `a37d…`, `5bc888…` and one fewer callsite in the workspace-write capability service. No evidence establishes that either side is the authorized successor. Required owner actions: (1) adaptive-goal knowledge/verifier source owner reviews `adaptive-goal-knowledge-verifier.js` semantics and approves the intended exact bytes; (2) workspace-write implementation owner reviews capability and receipt source changes/callsite delta; (3) AGG V2-01 register/test owner creates a reviewed successor inventory and updates the binding through the approved versioning procedure. Current Git history does not establish accountable human owners for all these uncommitted changes. Part 3 did not modify these three source files, the V2-01 test, v0.5.17 register, or historical baselines. The `agents` requests have no owner-authored ACK or successor authorization.

The green Rust/targeted Node suites prove local contract and regression behavior only. The local read-only MCP stdio Gateway is integrated, but this does not establish remote Control/Execution identity, durable mutating idempotency, independently deployed Governance, production signing/checkpoint authority, accepted database topology, cross-process service integration or release readiness.
