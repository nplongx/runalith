# WS2 Control Route / MCP / Digest Registry V1

**Status:** `DRAFT_NOT_RATIFIED`  
**Machine-readable source:** `02-control-route-mcp-digest-registry-v1.json`  
**Validator:** `02-control-route-mcp-digest-registry-v1-test.py`

## 1. Purpose and boundary

This registry closes one bounded part of cross-workstream issue #58: identify current Control HTTP routes, their capability gates and injected authority methods; inventory MCP tool names and the actual local read-only Gateway surface; map known route/tool relationships; and keep digest domains separate. Source hashes pin the inspected code.

It is not a route activation request, a signed-byte contract, a production trust profile, or approval to change a Store schema. `DRAFT_NOT_RATIFIED` remains the status of cross-part DTOs and producer/consumer contracts.

## 2. Control HTTP contract

`ControlApi` uses bounded HTTP JSON: request body <=1 MiB; headers <=16 KiB. Bearer authentication is resolved by host-injected `ControlPrincipalVerifier`; `subject`, `issuer` and capabilities are host-derived. Request JSON does not grant its own capabilities.

Worker routes and required capabilities are recorded in the JSON registry. The critical runtime fact: `ControlApi` requires a host-injected `WorkerControlAuthority`; without it, `/v1/worker/*` returns `503` before any lease or side-effect acknowledgement. A test-only `WorkerControlAuthority` is not a production configuration.

The current route adapter does not impose one common versioned request DTO or a generic request digest on all worker paths. The Store's renewal and fence structs are internal unversioned DTOs; the V2 fence and LeaseRenewalV1 public projections in V2.1 are proposals, not current Store wire structs.

## 3. Route-to-MCP relationships

The registry marks only source-proven relationships:

| Control HTTP route | MCP tool | Relationship |
|---|---|---|
| `GET /v1/workflows` | `workflow_list` | Same read service operation |
| `POST /v1/workflows` | `workflow_create` | Same create-proposal service operation; different auth surface |
| `GET /v1/workflows/{workflow_id}` | `workflow_get` | Same read service operation; not in local read-only Gateway allowlist |
| `POST /v1/workflows/{workflow_id}/approve` | `workflow_approve` | Same service method, but actor binding differs; MCP arguments carry `actor`, HTTP uses authenticated principal subject |
| `POST /v1/workflows/{workflow_id}/tasks/{task_id}/result` | `workflow_record_task_result` | Same Store envelope-ingest method; different wire/auth surface |
| `GET /v1/workflows/{workflow_id}/events` | `workflow_events` | Same read service operation |
| `GET /v1/workflows/{workflow_id}/tasks/{task_id}` | `workflow_attempt_inspect` | Same read inspection service operation |
| `POST /v1/coordinator/tick` | `workflow_claim_task` | **Not equivalent**: direct task claim is not coordinator ready-task selection or parallel admission |

The worker-specific Control routes do not have exact MCP aliases. In particular, `workflow_provider_reconcile` is not `/v1/worker/provider-results`; reconciliation performs provider lookup/reconciliation, while provider-results is a worker publication boundary.

## 4. MCP exposure and idempotency

The current Rust MCP source registers 62 tools. The local authenticated stdio Gateway allowlist contains only 14 read-only tools (exact names in JSON). This allowlist, not the tool catalog annotations alone, determines Gateway exposure. Source comments explicitly note that the legacy `readOnlyHint` annotations for `workflow_recovery_quarantine_expired` and `workflow_provider_reconcile` are inconsistent with mutation/external side effects; both are excluded from the Gateway.

`McpServiceRequestV1` has a 1 MiB serialized limit and validates `schema_version`, request/correlation IDs, host principal, operation, capability, effect class, name, arguments and idempotency key. Mutating requests require `idempotency_key`. The local Gateway currently sets it to `None`; it does not substitute JSON-RPC `id`. Therefore local stdio mutating calls fail closed with `MUTATION_IDEMPOTENCY_UNAVAILABLE` before handler invocation. `serve_stdio` also refuses to start without host-composed authenticated Gateway context.

JSON-RPC `id` is converted with `Value::to_string()` into `McpServiceRequestV1.request_id`. It is an identity/correlation field, not a durable retry key. `correlation_id` is `stdio:{connection_id}`. Neither the MCP service request nor response defines a digest field; response validation binds `schema_version`, exact `request_id`, expected `service_id` and size.

## 5. Digest domain separation

### Current source-defined algorithms

`runalith_domain::content_hash<T>` serializes `T` with `serde_json::to_vec`, hashes those bytes with SHA-256 and returns lowercase hex. This is a deterministic Rust serde byte profile for the pinned type/source; source does not declare it RFC 8785/JCS or promise cross-language canonical bytes for arbitrary JSON values.

Store uses that helper for:

| Digest | Exact source-defined preimage | Distinction |
|---|---|---|
| `proposal_hash` | `WorkflowProposal` serde bytes | Not the plan hash |
| inner `plan_hash` | `WorkflowPlan` serde bytes | Not outer `PlanDigestV1.value` |
| TaskResult `payload_sha256` | JSON object `{workflow_id, task_id, event_id, producer_id, request}` | Binds exact result envelope; event ID is inbox idempotency identity |
| Store fence reservation receipt `request_sha256` | Complete typed `WorkerExecutionFenceRequest` serde bytes | Internal Store digest; not side-effect `request.request_sha256` |
| fence `completion_sha256` | Typed `WorkerExecutionFenceCompletion` serde bytes | Completion record digest |

### Other domains that must stay separate

`CompiledPlanV1` outer `PlanDigestV1.value` hashes `canonical_content()` and binds the inner workflow plan plus workflow-definition, role-definition and skill pins, and optional policy composition. WS1 owns that digest definition. WS1's consumer review told WS2 that `TaskClaim.plan_sha256` must bind this outer value, not the inner `WorkflowPlan` hash and not W8's outer payload digest. This mapping remains cross-part draft until immutable producer/consumer revisions are ratified.

ExecutionFence `request_sha256` is the exact side-effect request digest. Current Store treats it as an opaque caller-supplied binding and does not recompute its producer-specific preimage. The historical V2.1 crosswalk gives W4's `request_binding_sha256` profile; current W4 proposal revision and provider proof authority still require review. Store also computes a different internal full-reservation-request digest for its own reservation receipt. WS3 rejected exposing that internal hash as an extra public V2 field because its `deny_unknown_fields` DTO rejected it. The corrected test projection omits it; WS3 accepted the exact projection with limits.

`acl_sha256` is a digest of authenticated ACL decision inputs, not an ACL decision or signature. Current Store/Control route does not define its exact preimage. `event_sha256` and `outcome_sha256` are carried by fence completion, but current internal DTOs do not fully define their producer-side canonical preimages. Those require producer-owned immutable definitions.

Lease renewal has no digest field in the current Store request/receipt. Its idempotency is `renewal_id` plus exact typed request equality. MCP service V1 has no request/response digest fields. Provider payload digest and W8 outer envelope digest are separate semantic domains even where illustrative sample values match.

## 6. Exact validation

Run from repository root:

```sh
python3 -B rust/workstreams/02-control-route-mcp-digest-registry-v1-test.py
```

The validator checks JSON structure, all source SHA-256 pins, exact registered MCP tool count/name set, exact read-only allowlist, route/capability source anchors, digest algorithm source anchors, and JSON-RPC/idempotency boundaries. It does not assert the existence of absent production authority or cryptographic profiles.

## 7. Remaining blockers

1. Production Store-backed `WorkerControlAuthority` and authenticated claim issuer/verifier remain unconfigured.
2. No canonical TaskClaim signed-byte preimage, issuer/audience/key custody, freshness/revocation/high-water or durable nonce/replay authority is assigned.
3. No authenticated ExecutionFence public receipts or durable public receipt lookup/history across restart/expiry/reassignment.
4. ACL/event/outcome digest preimages still need producer-owned definitions and immutable positive/negative/cross-runtime vectors.
5. MCP mutating service requests remain disabled until a durable idempotency adapter is assigned and implemented.
6. CR-03 and CR-09 remain open/blocking; D-01 and D-02 are unresolved; WS4 migration is not authorized.

**Disposition:** `IMPLEMENTED_AS_SOURCE_INVENTORY / STRUCTURAL_VALIDATION_PENDING`. No production source, schema, SQL, manifest, ACL, credential or deployment changed.
