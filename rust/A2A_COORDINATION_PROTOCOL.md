# Eight-Workstream A2A Coordination Protocol

**Revision:** 2026-11-03, v1 draft
**Status:** COORDINATION PROTOCOL DRAFT — not a domain-contract ratification
**Scope:** contract discovery, proposal exchange, technical review, blocker resolution and handoff across WS1–WS8.

This protocol implements the coordination process described in `EIGHT_PART_PARALLEL_PLAN.md`. It does not change ADR 0003, the three-deployable architecture, database ownership, D-01, source-file ownership, production authority, deployment or cutover permissions.

## 1. Operating invariants

1. A2A is the coordination transport. Do not use Google Chat as a fallback or middleware.
2. `a2a_endpoint_list.peer_directory` is the broker-wide routing inventory. `endpoints` is the authenticated identity's owned endpoint list. Never infer a Workstream from an owner fingerprint alone; match the endpoint ID and owner-asserted label.
3. Each logical Workstream uses its own endpoint, even when two Workstreams share one ContextForge identity. Configure and audit endpoint-specific ACLs only.
4. A successful send proves durable queue acceptance, not recipient delivery, reading, agreement or approval.
5. `a2a_message_ack` acknowledges transport handling only. It does not mean a contract was accepted or ratified.
6. An A2A reply must preserve the original `correlation_id` and reference the original `message_id`. It is a response, not an approval unless its body explicitly records a review decision by the authorized producer/consumer owner.
7. Contract semantics belong to the producer Workstream. WS8 owns common envelope/wire serialization, route and compatibility mechanics; it cannot ratify producer-domain semantics.
8. Keep all unknown, ambiguous, missing-authority and stale states explicit. Never convert missing evidence to PASS, zero, false or a terminal state.
9. No shared-file edits by multiple agents. No reset, clean, stash, revert, broad formatter, commit, DB split/migration, production key provisioning, live provider dispatch, deployment or cutover under this coordination protocol.

## 2. Endpoint directory and routing identity

The COS broker directory currently exposes eight active endpoint records:

| Workstream | Endpoint ID | Label |
|---|---|---|
| WS1 | `fe692d74-c735-417f-8252-359e17453b22` | WS1 |
| WS2 | `437be3a9-103a-4a76-b214-a5925207df30` | WS2 |
| WS3 | `ea54914b-66e9-41ed-b051-ad315bacd6fd` | WS3 |
| WS4 | `05ac6126-0e9a-4e95-9808-95172af91f2b` | WS4 |
| WS5 | `7860fbee-58d9-483e-a0d5-df34785fbec1` | WS5 |
| WS6 | `be6f2ea2-e6af-4758-a2c8-d72701d60a85` | `workstream-6-governance-authority` |
| WS7 | `37d75f7c-7873-4e33-955a-ac49f308eed6` | WS7 |
| WS8 | `3ca5589a-b386-4e3c-9e17-c1fc25979e6d` | WS8 |

These IDs are the routing identities for this coordination round. Re-read the live directory before sending; stop if an ID is inactive, missing or owned by an unexpected identity. Do not copy `sender_acl_token` values into project docs or messages; read them from the live directory only when an owner needs to configure its own endpoint ACL.

All eight endpoints were observed in `acl_mode=endpoint`, with zero legacy fingerprint ACL entries. A read-only broker DB audit joined `a2a_endpoint_peer_acl` to endpoint labels and verified exact sender membership:

| Recipient endpoint | Exact allowed sender endpoints |
|---|---|
| WS1 | WS2, WS6, WS8 |
| WS2 | WS1, WS3, WS6, WS8 |
| WS3 | WS2, WS4, WS5, WS8 |
| WS4 | WS3, WS5, WS8 |
| WS5 | WS3, WS4, WS7, WS8 |
| WS6 (`workstream-6-governance-authority`) | WS1, WS2, WS7, WS8 |
| WS7 | WS1, WS2, WS5, WS6, WS8 |
| WS8 | WS1, WS2, WS3, WS4, WS5, WS6, WS7 |

This is broker-stored authorization evidence, not a Workstream owner's sign-off on every logical review. Re-read live ACLs before adding an edge. Never infer membership from `allowed_sender_count` alone.

## 3. Contract dependency and review graph

The graph below follows the contract dependency graph in `EIGHT_PART_PARALLEL_PLAN.md`. It is a contract/review graph, not a synchronous runtime call chain.

| Producer | Required consumer/reviewer | Main contract surface |
|---|---|---|
| WS6 | WS1 | `TrustedSkillResolutionV1`, trust snapshot, immutable skill version and digest semantics |
| WS6 | WS2 | approval/authorization receipt, exact subject, issuer, freshness, revocation and nonce semantics |
| WS6 | WS7 | trust/verifier/signer policy, source-verification authority and nonce/replay contract |
| WS1 | WS2 | `CompiledPlanV1`, digest/canonicalization, task DAG and policy attachment mapping |
| WS1 | WS7 | read-only plan/workflow/candidate subject and plan-digest references |
| WS2 | WS3 | `TaskClaimV1`, `LeaseRenewalV1`, cancellation request and owner/fence binding |
| WS3 | WS2 | claim-bound process observations, result envelope and local process-stop evidence (not provider terminality) |
| WS2 | WS7 | read-only workflow/task/attempt/lease/plan references and exact subject bindings |
| WS3 | WS4 | claim/fence identity, provider dispatch authorization and process/provider boundary |
| WS3 | WS5 | claim/session scope, producer identity, attempt and session time/expiry semantics |
| WS4 | WS5 | provider result reference, exact provider/account/run identity and artifact handoff |
| WS5 | WS7 | content digest, `ArtifactManifestV1`, producer/attempt lineage and evidence source binding |
| WS8 | WS1–WS7 | common envelope/wire mapping, supported versions, route metadata and producer-owned DTO mapping review |

The list above is intentionally limited to the directed graph in the master plan. Optional technical consultation outside these edges is not a permission to send; it requires an explicit review-matrix addition and recipient ACL authorization.

For a request/reply exchange, both endpoint owners must permit the peer endpoint: the recipient ACL authorizes the request, and the original sender ACL must authorize the reply. An owner may keep additional exact peers only when the dependency/review matrix records why they are needed. No all-to-all ACL or all-to-all message fan-out.

### ACL-denied non-graph attempts

During this coordination round, WS2 attempted additional review sends to WS4 and WS5, and WS4 attempted additional review sends to WS2 and WS6. The broker denied these sends because recipient ACLs did not authorize those sender endpoints. These pairs are not edges in the master plan's contract dependency graph. Treat the denials as `ACL_DENIED_NON_GRAPH_EDGE`, not as a broker outage and not as reason to broaden ACLs. Do not retry or widen authorization unless Project Owner approves the additional review edge and endpoint owners explicitly update both required directions.

## 4. Standard A2A coordination message

Every contract-related A2A message body must contain these fields (plain text or JSON is acceptable; JSON is preferred):

```json
{
  "coordination_protocol": "cos-a2a-contract-coordination/1",
  "message_type": "CONTRACT_PROPOSAL | CONTRACT_REVIEW_REQUEST | CONTRACT_REVIEW | CONTRACT_DECISION | BLOCKER | HANDOFF",
  "from_workstream": "WSn",
  "to_workstream": "WSm",
  "contract_id": "urn:runalith:contract:<name>:v<major>",
  "contract_version": "<draft version or proposed major.minor>",
  "contract_status": "DRAFT | PROPOSED | REVIEW_REQUESTED | CHANGES_REQUESTED | PRODUCER_APPROVED | RATIFIED | SUPERSEDED",
  "producer_owner": "WSn",
  "consumer_reviewers": ["WSm"],
  "source_revision": "<git commit or 'working-tree; uncommitted'>",
  "source_paths": ["rust/workstreams/...", "rust/crates/..."],
  "summary": "<bounded summary>",
  "required_semantics": ["ownership", "subject binding", "state/error semantics", "idempotency", "ordering", "negative cases"],
  "compatibility_notes": ["<existing implementation / Node behavior / unresolved adapter>"],
  "test_evidence": [{"command": "<exact command>", "result": "PASS | FAIL | BLOCKED | NOT RUN", "scope": "<what the test actually proves>"}],
  "open_questions": ["<exact decision requested>"],
  "requested_response": "REVIEW_ACCEPTED | CHANGES_REQUESTED | BLOCKED with evidence"
}
```

The outer A2A `correlation_id` is stable for the conversation about one contract/review round. The `idempotency_key` is unique per send operation and must not be reused with a changed body. Include the original A2A message ID in replies. Never invent a Git revision, test result, owner approval or schema digest.

## 5. Contract lifecycle and acceptance vocabulary

| State | Meaning | Who may assert it |
|---|---|---|
| `DRAFT` | Local candidate exists; semantics or fields may still change. | Producer Workstream |
| `PROPOSED` | Producer sent a concrete versioned candidate for review. | Producer Workstream |
| `REVIEW_REQUESTED` | Exact consumer owners were asked to review named paths/version. | Producer or coordinator, with message IDs |
| `CHANGES_REQUESTED` | Consumer identified a specific incompatible or missing requirement. | Consumer reviewer, with evidence and requested change |
| `PRODUCER_APPROVED` | Producer accepted a specific reviewed revision. | Producer owner only |
| `RATIFIED` | Producer and all required consumer/authority owners approved exact same immutable revision; required Project Owner/architecture decision is recorded where needed. | Authorized accountable owners only |
| `SUPERSEDED` | A newer approved revision replaced this one; prior revision remains traceable. | Producer owner |

The current ownership tables still mark accountable owners `UNASSIGNED` for most Workstreams. Therefore agent-level technical review can produce `REVIEW_ACCEPTED` or `PRODUCER_APPROVED` only when the agent is acting within its documented Workstream responsibility; it must not be represented as named accountable-owner sign-off. `RATIFIED` remains unavailable until required authority/owner approval is actually recorded.

An A2A transport ACK is not a contract-review decision. A reply that says “received” is not approval. A reviewer must name the exact contract version, source revision, accepted fields/invariants, rejected fields and unresolved questions.

## 6. Review checklist

Each producer must publish, for every contract in scope:

1. Exact schema path and version; required/optional fields; unknown-field and unknown-version behavior.
2. Producer identity, owner, consumer, audience and exact subject binding.
3. State machine, terminal vs nonterminal vs UNKNOWN/UNRESOLVED semantics, errors and retry safety.
4. Idempotency scope, canonicalization profile, payload digest, replay/conflict behavior and ordering/predecessor rules.
5. Security/authority source, signature/verifier/nonce/freshness/revocation requirements, including what is explicitly not proven.
6. Compatibility mapping from existing Rust/Node behavior, golden fixtures and known divergences.
7. Exact test command, result and test scope. Unit success is not production/service acceptance.

Consumers review the published DTO and semantics, not private structs, SQL, filesystem paths or another Workstream's implementation details. A reviewer must classify each issue as `BLOCKING`, `NON_BLOCKING`, or `INFORMATIONAL` and cite the field/rule/test that supports the classification.

## 7. Known review topics that must not be papered over

- **WS1 ↔ WS6 trusted skill:** Node `bundle_sha256` is a digest over sorted per-file manifest entries; legacy Store `content_sha256` is a content-byte digest. They are not equivalent. W1 needs immutable skill version, exact bundle-manifest digest and a trust snapshot/verified-authority reference with freshness/revocation semantics from W6. Do not synthesize one digest from the other.
- **WS1 ↔ WS2 plan/policy:** W1 `PolicyPlanContextV1` maps catalog role IDs, while the legacy Node custom-plan adapter presents synthetic child role labels. W2 must define the adapter mapping. `execution_exit_code_equals` requires explicit `ExecutionManager` identity. W2 owns live policy attachment/evaluation; W1 owns immutable schema/composition.
- **WS2 ↔ WS3 claim/fence:** Cross-part `TaskClaimV1`, issuer/audience, worker identity, plan/attempt/lease/owner-epoch binding and renewal/expiry semantics remain draft. Existing Worker API claim schema v3 is related, not automatically the ratified cross-part contract.
- **WS3 ↔ WS4 side effects:** Local process-tree stop is not proof of provider-side no-more-side-effects. Cancellation ACK, process-stop proof and provider terminal proof are distinct facts.
- **WS4 ↔ WS6 provider origin:** A payload digest proves byte integrity, not provider origin. Independent provider/account/run authentication, verifier key/config snapshot, freshness and one-use nonce semantics remain unresolved; raw provider JSON cannot become trusted terminal truth.
- **WS3/WS4 ↔ WS5 sessions/artifacts:** W5's `SessionRefV1` requires exact claim identity and session-created-at/time semantics. Do not construct a reference from incomplete legacy fields. Artifact presence/digest alone is not producer authentication or VERIFIED evidence.
- **WS5 ↔ WS7 evidence:** `ArtifactRefV1`/manifest/lineage must preserve exact bytes, producer, workflow/task/attempt and immutable source lineage. Missing/stale/ambiguous lineage stays UNKNOWN.
- **WS6 ↔ WS7 verifier:** W6 owns trust roots, signer/verifier/key policy and authority; W7 owns AGG evidence/checkpoint records and algorithms. W7 cannot mint trust or sign with W6 authority. No production nonce adapter is implied by in-memory tests.
- **WS1–WS7 ↔ WS8:** Common envelope v1, canonical digest profile, route registry, remote principal/authentication, supported-version negotiation, error mappings and idempotency forwarding are still proposals. W8 cannot invent producer-domain semantics or private service paths.

## 8. Operational cadence

1. At start of a work session, each Workstream calls `a2a_endpoint_list`, verifies its owned endpoint and reads its inbox with a persistent `after_seq` cursor.
2. Producer sends one proposal per contract/reviewer pair, not one giant all-to-all message. Keep each message under the broker limit.
3. Consumer replies with exact `REVIEW_ACCEPTED`, `CHANGES_REQUESTED` or `BLOCKED` outcome and evidence. Consumer ACKs the original only after processing it.
4. Producer responds to every blocking review with a new immutable revision or a justified disposition. Do not mutate an already-proposed version in place.
5. Producer re-sends a new version under a new idempotency key; reviewers identify old/new versions explicitly.
6. Before ending a session, each Workstream reports sent, received, replied and ACKed message IDs, contract status, tests, blockers and next owner action.

There is no automatic wake-up guarantee. The current mailbox is pull-based. Inbox polling must be explicit; a queued message does not prove an agent ran.

## 9. Repository and authority boundary

This protocol is documentation-only. Workstream agents must not edit other Workstreams' owned files. Do not share-write `runalith-protocol`, `runalith-domain`, `runalith-store`, `runalith-runtime`, root/workspace manifests, `Cargo.lock` or migrations without a single named coordinating owner, isolated worktrees, a reviewed patch and explicit owner approval. Planning, contract drafts and fixture work may continue in isolated/disjoint ownership. D-01, production keys/trust roots, DB split/cutover, live provider dispatch and production deployment remain blocked by their existing gates.

## 10. Related records

- `rust/EIGHT_PART_PARALLEL_PLAN.md` — architecture, ownership and dependency authority.
- `rust/workstreams/01-workflow-catalog-compiler.md` through `07-agg-evidence-checkpoint.md` — producer/consumer responsibilities and current implementation snapshots.
- `rust/workstreams/08-gateway-protocol-contract-v1.md` — common envelope/wire proposal, currently DRAFT.
- `rust/A2A_CONTRACT_REVIEW_REGISTER_20261103.md` — initial review queue and per-contract status.
