# Rust MCP semantic parity inventory

Status: source-derived inventory, **not a claim of semantic or production parity**.
The Node reference is `server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js`.
The Rust inventory is `runalith-mcp::tool_definitions()` and its `McpServer::call_tool`
handlers. Counts below are source measurements, not inferred from documentation.

**Freshness note (2026-11-07):** this inventory was last measured on 2026-11-02. Its tool counts and per-operation classifications are not claimed as a fresh extraction in this publication pass. Current full-workspace Rust validation and acceptance status are in the [repository status snapshot](STATUS_2026-11-07.md).

## Measured surface

| Surface | Count | Meaning |
|---|---:|---|
| Node `TOOL_DEFS` | 75 | All definitions in the pinned source manifest |
| Node default-visible | 72 | 75 minus three opt-in tools: Phase 2 shadow search, Phase 3 MCTS shadow search, Phase 4 knowledge capture |
| Rust registered | 62 | `registered_tool_count()` / `tool_definitions().len()` |
| Exact-name overlap | 28 | Same spelling only; does not establish matching schemas or behavior |
| Node-only names | 47 | 44 default-visible plus three opt-in |
| Rust-only names | 34 | Rust-native or differently named operations |

The 75 Node definitions, 62 Rust definitions and 28 shared names were extracted
from the source arrays. The pinned Node source comment says “67-tool surface”,
but its actual `tools/list` filter removes only the three opt-in definitions, so
the measured default-visible count is 72; the comment is stale. No placeholder
handlers were added to inflate counts.

### Rust stdio registration and dispatch reachability

Rust `tools/list` and `tools/call` now use the same `tool_definitions()` catalog
as the source of registered names. The previous second, hand-maintained dispatch
allow-list had drifted: eight registered tools (`workflow_recommend_resources`
and the seven `workflow_policy_*` operations) were advertised but returned
JSON-RPC `-32602 unknown tool name` when called. Dispatch now rejects names not
present in the advertised catalog and no longer maintains a duplicate name
list.

The MCP regression `every_listed_tool_has_a_stdio_dispatch_route` sends a
deliberately invalid closed-schema argument to every registered tool and asserts
that each request reaches the MCP tool-result validation path rather than the
JSON-RPC unknown-name path. The invalid argument is rejected before each tool
handler can run, including mutating handlers. A companion negative test asserts
that an unregistered name still returns `-32602`. This proves name registration
and route reachability only; it does **not** prove that every handler's valid
input, authorization, side effects, output or errors match Node semantics.

## Exact-name overlap

All shared names remain **partial semantic parity** except `workflow_validate_artifact`,
`custom_workflow_clone`, and `custom_role_clone`, which now have tested compatible subsets.
`workflow_recommend_resources` is a new partial implementation: it uses real Store-backed
catalog records and built-in role contracts, but omits skill metadata and profile-overlay
compatibility because those host APIs are not exposed by the Rust catalog.
“Exact name” means only identical
identifier; schemas, authorization, side effects, persistence and response shape
still differ in several cases.

| Node / Rust name | Rust behavior | Parity classification and limits |
|---|---|---|
| `orchestrator_health` | Read-only Rust SQLite quick-check and durable counts | Partial: no Node plugin startup manifest hash, Node runtime phase mismatch, provider probes or host liveness |
| `adaptive_goal_graph_search` | Bounded Rust graph search and review-only projection | Partial: graph model, search lineage and Node candidate semantics differ |
| `workflow_policy_catalog` | Rust closed predicate catalog and enforcement status | Compatible subset; catalog vocabulary is not proof of Node policy behavior |
| `workflow_policy_create` | Store-backed immutable policy version; host catalog author required | Partial: Rust host identity and schema constraints differ |
| `workflow_policy_list` | Store-backed bounded list/history | Partial: output envelope and filtering differ |
| `workflow_policy_get` | Exact/latest version and attachment readback | Partial: response envelope differs |
| `workflow_policy_update` | Append-only version update; host catalog author required | Partial: input validation and actor binding differ |
| `workflow_policy_validate` | Closed-schema validation and digest preview | Partial: predicate support/enforcement coverage differs |
| `workflow_policy_attach` | Atomic exact-version attachment to eligible proposal | Partial: lifecycle/actor semantics differ; approval remains a separate gate |
| `workflow_create` | Persist Rust workflow proposal | Partial: Rust proposal/task schema is not Node workflow schema |
| `workflow_list` | Bounded active Rust workflow projection | Partial: state set and metadata differ |
| `workflow_get` | Rust workflow/task projection | Partial: Node runtime, artifact and execution projections are not fully present |
| `workflow_approve` | Calls host approval verifier; default host denies | Partial/fail-closed: no production Control authenticator, trust provisioning or signing authority |
| `workflow_events` | Bounded Rust event journal read | Partial: event model and payload contract differ |
| `workflow_validate_artifact` | Pure typed content validation plus optional built-in role output-type check | Compatible validation subset: all ten Node artifact content families, required fields, semantic checks and role mapping are implemented and tested. Does not persist or validate full artifact identity/hash/evidence/producer-attempt lineage. |
| `workflow_recommend_resources` | Read-only deterministic lexical ranking over persisted custom roles, workflows, policies and built-in role contracts | Partial: schema, read-only behavior, Vietnamese-English phrase expansion and deterministic ranking are tested. Rust computes contract-compatible overlay role candidates using built-in input/output contracts, but Rust proposal APIs cannot apply Node role-profile bindings. Rust stores skill IDs only and does not expose Node skill name/description/hash metadata. No resource is attached and no authority is granted. |
| `workflow_diagnose` | Durable Rust workflow/task/attempt diagnosis | Partial: does not inspect Node runtime sessions, heartbeat or provider status |
| `custom_role_create` | Immutable Rust role version; host author required | Partial: trusted skill resolution and Node role fields are not fully equivalent |
| `custom_role_update` | Append immutable Rust role version | Partial: exact field/skill snapshot semantics differ |
| `custom_role_get` | Exact/latest Rust role version | Partial: response shape differs |
| `custom_role_list` | Bounded Rust role catalog | Partial: filter/history envelope differs |
| `custom_role_clone` | Copies latest immutable role into new version 1; preserves exact verified skill-pin rows; requires host-authenticated author | Compatible subset. Store transaction validates source definition digest and complete pin set, revalidates non-empty source pins against host resolver, atomically copies pins and appends catalog event. Replacement skills also require host resolver. Tests verify exact pin preservation, tampered-pin rejection and fail-closed replacement without resolver. |
| `custom_workflow_create` | Immutable Rust workflow definition with exact role pins | Partial: typed Rust task schema differs from Node input schema |
| `custom_workflow_update` | Append immutable Rust workflow version | Partial: field validation and trusted skill composition differ |
| `custom_workflow_get` | Exact/latest Rust workflow version | Partial: response envelope differs |
| `custom_workflow_list` | Bounded Rust workflow catalog | Partial: filter/history envelope differs |
| `custom_workflow_preview` | Persist Rust immutable compiled plan | Partial: plan schema/digest semantics differ from Node preview |
| `custom_workflow_clone` | Copies latest source into new version 1; optional overrides; exact referenced role versions remain pinned; requires host-authenticated catalog author | Compatible subset. Tested source immutability, default copy name, version 1, and role-version pin preservation. Rust intentionally rejects unauthenticated authors. |

## Node-only operations

Classification uses the closest Rust operation only when semantics overlap. A
partial counterpart is **not** advertised as a compatible alias.

| Node tool | Rust counterpart | Classification / gap |
|---|---|---|
| `workflow_coordinator_role` | — | Missing built-in coordinator-role catalog surface |
| `workflow_coordinator_step` | `workflow_ready_tasks`, `workflow_claim_task`, `workflow_record_task_result`, `workflow_synthesize` | Partial components only; no equivalent high-level coordinator loop or combined lifecycle contract |
| `adaptive_goal_phase2_shadow_search`* | `adaptive_goal_phase2_rank` | Partial: ranking existing validated candidates is not Node's full shadow-search contract |
| `adaptive_goal_phase3_mcts_shadow_search`* | `adaptive_goal_mcts_shadow_search` | Partial: bounded Rust MCTS differs in inputs/output and remains non-exhaustive shadow search |
| `adaptive_goal_recovery_resolve` | — | Missing outcome-aware recovery route resolver |
| `adaptive_goal_knowledge_node_save` | `graph_node_append` | Partial: stable cross-goal identity/revision/provenance semantics are not fully equivalent |
| `adaptive_goal_knowledge_capture_workflow_outcome`* | — | Missing; opt-in Node-only capture operation |
| `adaptive_goal_knowledge_edge_add` | `graph_edge_append` | Partial: relation schema/provenance contracts differ |
| `adaptive_goal_knowledge_search` | `adaptive_goal_graph_search` | Partial: search projection is not the Node cross-goal knowledge listing contract |
| `adaptive_goal_knowledge_snapshot_get` | `graph_snapshot_get` | Not an equivalent alias: Node requires `goal_id` and reads/revalidates the goal-scoped knowledge snapshot; Rust requires `graph_id` and optionally an exact graph snapshot revision. Rust's `graph_snapshot_create` remains a separate append-only mutation. |
| `adaptive_goal_trust_configuration_status` | — | Missing MCP operation. The Node status path loads all five administrator configurations from host environment, records/checks trust high-water observations (`record: true`), and verifies provider/root separation. It is therefore not a read-only status query. Rust has D-01 Store repositories and transaction-scoped observation, but no production environment/configuration provisioning composition or administrator authority; exposing a superficial read-only projection would not be equivalent. |
| `adaptive_goal_knowledge_snapshot_attest` | — | Missing; requires independent verifier, trust root, signed evidence and nonce authority |
| `adaptive_goal_knowledge_graph_search` | `adaptive_goal_graph_search`, `adaptive_goal_phase2_rank` | Partial: no equivalent proof of fresh trusted attestation and full evidence lineage |
| `adaptive_goal_knowledge_node_get` | — | Missing exact node/revision read API in MCP |
| `adaptive_goal_knowledge_node_history` | — | Missing exact immutable node history API in MCP |
| `adaptive_goal_knowledge_recovery_resolve` | — | Missing evidence-backed persisted recovery-edge resolver |
| `adaptive_goal_plan_compatibility_check` | `adaptive_goal_plan_project` | Partial: projection is not full Node template compatibility assessment |
| `adaptive_goal_plan_proposal_create` | — | Missing persisted review-only Plan Graph proposal lifecycle |
| `adaptive_goal_plan_proposal_get` | — | Missing exact proposal snapshot read/revalidation |
| `adaptive_goal_execution_readiness_check` | — | Missing complete action-to-task/evidence readiness check |
| `adaptive_goal_execution_graph_proposal_create` | — | Missing persisted Execution Graph proposal creation |
| `adaptive_goal_execution_graph_proposal_get` | `workflow_execution_graph_get` | Partial: Rust read projection does not establish all Node freshness/revalidation guarantees |
| `adaptive_goal_execution_plan_candidate_create` | — | Missing candidate persistence and trusted reviewer-attestation binding |
| `adaptive_goal_execution_plan_candidate_get` | — | Missing exact candidate rebuild/revalidation |
| `adaptive_goal_reviewer_attestation_ingest` | — | Missing; no production reviewer identity provider or ingestion authority |
| `adaptive_goal_sandbox_action_execute` | `workflow_sandbox_execute` | Partial: Rust sandbox contract is not the same one-action Node fixture executor |
| `workflow_catalog` | — | Missing built-in Node workflow template catalog |
| `workflow_liveness_diagnostics` | `workflow_diagnose`, `workflow_attempt_inspect` | Partial only: Rust has durable attempt/lease metadata, not Node active-lease heartbeat/expiry and runtime timestamp inventory; must not infer worker death |
| `workflow_preflight` | `workflow_diagnose` | Missing semantic equivalent: diagnosis does not validate approval quorum, proposal feasibility or dispatch preconditions |
| `workflow_dispatch` | `workflow_claim_task`, `workflow_provider_reconcile` | Missing semantic equivalent: claim/reconciliation are not dispatch orchestration |
| `workflow_prepare_tasks` | `workflow_ready_tasks` | Partial: Rust returns a read-only ready-task projection; it does not prepare/dispatch tasks |
| `workflow_next_task` | `workflow_claim_task` | Partial: claim API is lower-level and has a different response/ownership contract |
| `workflow_request_rework` | — | Missing rework transition |
| `workflow_request_reviewer_revision` | — | Missing reviewer revision transition |
| `workflow_complete_task` | `workflow_record_task_result` | Partial: typed result/evidence and lifecycle semantics differ |
| `task_execute_local` | `workflow_sandbox_execute` | Partial: execution scope and approval/plan guards differ |
| `workflow_write_files` | `runalith-sandbox::workspace_write` library API | Not an MCP operation; capability issuance/approval integration remains incomplete |
| `execute_batch` | — | Missing batch execution orchestration |
| `workflow_complete_synthesis` | `workflow_synthesize` | Partial: output schema, evidence and terminal lifecycle differ |
| `workflow_artifacts` | `runalith-artifacts` crate | Missing MCP artifact listing/read surface. `ArtifactStore` is a content-addressed blob store (`artifact_id`, SHA-256, byte length, media type); `TaskResult.evidence` stores typed evidence references, but `WorkflowView`/`TaskView` do not persist a workflow/task/attempt-to-`StoredArtifact` registry. Listing blobs as workflow artifacts would fabricate lineage, so no MCP operation is added. |
| `workflow_e2e_run` | — | Missing end-to-end workflow execution surface |
| `workflow_recovery_verify` | `workflow_verify_event_chain`, `workflow_attempt_inspect`, `workflow_recovery_quarantine_expired` | Partial: journal integrity and attempt inspection are not Node recovery verification |
| `workflow_record_intervention` | — | Missing durable operator intervention write API |
| `workflow_interventions` | — | Missing operator intervention read API |
| `workflow_access_diagnostics` | `agent_session_inspect` | Partial: Rust session ACL inspection does not cover Node workflow access diagnostics |
| `custom_workflow_approve` | — | Missing plan approval operation; no host-owned plan approval authority is provisioned |
| `custom_workflow_run_create` | `workflow_create` | Not an alias: Rust workflow proposal creation does not consume an approved custom plan to create an authorized run |

* Opt-in in the Node reference; hidden from default `tools/list` unless the
  corresponding `AGG_PHASE*_..._ENABLED=1` setting is explicitly enabled.

## Rust-only operations

These 34 names are Rust-native or differently named. They do not increase the
Node semantic parity count:

`workflow_ready_tasks`, `workflow_compile`, `workflow_attempt_inspect`,
`agent_session_create`, `agent_session_list`, `agent_session_inspect`,
`agent_session_update`, `agent_session_access_grant`,
`agent_session_access_revoke`, `agent_session_attach`,
`agent_session_takeover`, `agent_session_message_enqueue`,
`agent_session_message_claim`, `agent_session_message_start`,
`agent_session_message_receipt`, `agent_session_message_ack`,
`agent_session_message_uncertain`, `workflow_claim_task`,
`workflow_record_task_result`, `workflow_recovery_quarantine_expired`,
`workflow_verify_event_chain`, `workflow_synthesize`, `graph_create`,
`graph_node_append`, `graph_edge_append`, `graph_evidence_capture`,
`graph_snapshot_create`, `graph_snapshot_get`, `adaptive_goal_phase2_rank`,
`adaptive_goal_mcts_shadow_search`, `adaptive_goal_plan_project`,
`workflow_execution_graph_get`, `workflow_sandbox_execute`,
`workflow_provider_reconcile`.

Some are useful lower-level primitives for Node-only operations, but a primitive
does not provide the orchestration, authorization or response contract of its
higher-level counterpart.

### Rust-only per-operation semantics — `graph_snapshot_get`

This tool is a Rust-native operator read model, not a parity alias for Node's
goal-scoped knowledge snapshot API.

| Dimension | Rust behavior and evidence |
|---|---|
| Input schema | Closed object requiring `graph_id` (1–128 characters); optional `revision` is a positive safe integer up to `2^53-1`. Omission selects the latest persisted snapshot. |
| Persistence semantics | Calls the existing `Store::get_graph_snapshot(graph_id, revision)` read API. The Store validates snapshot digest, graph/revision identity, denormalized database fields and predecessor hash before returning the record. It does not create a snapshot or advance graph revision. |
| Authorization / capability | Local stdio host only; no authenticated per-request principal is supplied by the current stdio transport. This tool is read-only and does not grant workflow, evidence or execution authority. The independent Gateway is not wired to stdio. |
| Side effects / idempotency | Declared `readOnlyHint=true`, `idempotentHint=true`; only exact persisted snapshot content is returned. A missing graph/revision becomes a tool error; an unsafe revision is rejected by the closed input schema. Regression covers exact revision 1 after revision 2 exists, latest selection, missing revision and unsafe integer rejection. |
| Response / trust semantics | Returns the sealed `GraphSnapshot` projection with recursive MCP secret redaction and `snapshot_payload_redacted=true`; `snapshot_sha256` identifies the stored pre-redaction payload and cannot be recomputed from the projection. `handle_frame` serializes the complete JSON-RPC envelope once, including the actual request ID and modern metadata, measures those exact bytes and emits the same byte vector only within the 1 MiB cap; oversized snapshots fail with bounded `-32603`. It also returns `snapshot_created=false`, `execution_authorized=false`, `dispatch_allowed=false`. Per-evidence verification states are preserved exactly as sealed; the read operation does not verify bytes, change claim status or attest evidence. |
| Node comparison | Node `adaptive_goal_knowledge_snapshot_get` requires `goal_id` and returns the goal-scoped Node knowledge-store snapshot. Rust uses `graph_id` plus optional immutable snapshot revision. There is no demonstrated goal-ID-to-graph-ID mapping or equivalent result/lineage contract, so semantic equivalence is not claimed. |

## Cross-cutting contract comparison

| Dimension | Node reference | Rust stdio MCP | Independent Gateway contract |
|---|---|---|---|
| Input schema | `validateToolArguments` validates plain-object arguments against the declared JSON Schema subset before handler execution; top-level unknown keys are closed | Tool definitions publish closed schemas; handlers use typed Serde parsing and selected `ensure_only_keys` checks. There is no uniform full JSON Schema validation pass for every tool | Versioned request structural validation, message-size bound and `deny_unknown_fields`; tool-specific schema validation remains service responsibility |
| Authentication | Host runtime/transport and per-handler authority checks; no uniform principal envelope in `TOOL_DEFS` | Stdio `McpServer` has no per-request authenticated principal. Sensitive handlers fail closed when required host verifiers are absent; default workflow approval verifier denies | `McpPrincipalV1` carries subject, issuer, audience and authentication-context reference. `McpGateway` now requires a host-injected `McpTransportPrincipalAuthenticator` before audience checks or service access; service still reauthorizes each operation. No production authenticator/host composition is supplied |
| Authorization / capability | Handler-specific gates and policy checks; not one common capability request envelope | Per-operation host verifiers and lifecycle checks; no common capability authorization for stdio tool calls | `McpApplicationService::authorize` rechecks principal, capability, operation and side-effect class at service boundary |
| Side-effect classification | Must be read from each tool's handler; Node tool definitions do not provide one uniform side-effect contract. `adaptive_goal_trust_configuration_status` performs administrator observation/high-water writes despite its status name | Rust tool annotations expose `readOnlyHint` and `idempotentHint`; mutating and read-only handlers remain mixed in the same server. `orchestrator_health` is strictly read-only and requires an explicit host-injected database path | Explicit `McpSideEffectClass`; read-only and mutating invocation methods are separate |
| Idempotency | Domain-specific dedupe/replay rules; not a uniform request field across every tool | Per-operation persistence/CAS/replay rules; stdio request has no generic idempotency key | Mutating request requires an idempotency key; read-only request rejects one |
| Response validation | Handler result is wrapped by MCP; no universal per-tool output-schema validator | `tool_result` emits text plus `structuredContent`; no universal per-tool output-schema validator. Stdio bounds request IDs to 128 bytes, serializes each successful envelope once, caps successful/error JSON payloads at 1 MiB (line delimiters excluded), and replaces oversized error diagnostics with a bounded request-bound `-32603`. An oversized read-only result is `-32603`; an oversized response after a mutating handler returns is a request-bound `MUTATION_OUTCOME_UNKNOWN` requiring reconciliation and prohibiting automatic retry. | Response envelope validates schema version, request ID, service ID and result/error consistency; operation names are bounded and failure code/message must be non-empty and bounded. An ambiguous mutation invocation/invalid response is converted to a bound `UNKNOWN` outcome, not a definite client failure. It does not validate each tool's result schema |
| Error mapping | Handler-specific errors are returned through the Node MCP wrapper | Runtime errors become MCP tool errors; stable Node error-code compatibility is incomplete | Gateway has stable contract/authorization/response errors, but stdio is not wired to it |
| JSON-RPC request identity / notifications | The pinned handler validates the JSON-RPC envelope, then suppresses valid notifications without an `id`; it never calls a tool handler without a correlatable request ID | `handle_frame` routes requests without an `id` to notification handling and returns `None`; `tools/call` notifications are not dispatched. Present string IDs are bounded to 128 UTF-8 bytes and control-free; invalid IDs are rejected before error paths can echo an oversized value. Regression `tools_call_notification_without_request_id_never_mutates_workflow_state` creates a valid workflow payload without an ID and confirms the durable workflow list stays empty |

## Per-operation semantic evidence — `workflow_recommend_resources`

The independent Rust `McpGateway` capability-discovery boundary rejects
capability IDs that are blank, oversized, duplicated or contain Unicode
control characters (including CR/LF and NUL) after authorization and before
serializing the catalog. This protects the versioned service boundary; it is
not a claim that the local stdio host is already routed through that Gateway,
nor a Node `tools/list` parity result.

This is a newly implemented shared-name operation. It is **not** classified as
equivalent because its output deliberately reports unavailable Rust metadata and
the Rust runtime cannot apply Node role-profile bindings.

| Dimension | Node reference | Rust implementation and evidence |
|---|---|---|
| Input schema | Closed object: required `task` string 1–12,000; optional `limit` integer 1–10, default 5 | Same bounds and closed top-level object in `tool_definitions()`; handler independently checks non-empty task, max length and limit range. Negative tests reject whitespace-only task, limit 11 and unknown fields. |
| Output schema | `read_only`, `task_fingerprint`, matching method, four recommendation groups and selection rules; custom roles include skill hints and compatible overlay roles | Same top-level groups and selection rules; custom roles expose skill IDs only, `skill_metadata_available=false`, contract-compatible overlay candidates and `profile_overlay_runtime_supported=false`. No universal per-tool output-schema validator exists in either host. |
| Authorization / capability | Read-only catalog discovery; no attach, role mutation, approval or dispatch | Calls only `WorkflowService::list_custom_roles`, `list_custom_workflows`, `list_workflow_policies` and `builtin_roles`; no authenticated catalog actor required and no mutation capability. Overlay candidates are derived from exact built-in input/output contract compatibility; Rust does not apply bindings. |
| Side effects / read-only | Read-only lexical discovery | `readOnlyHint=true`, `idempotentHint=true`; tests verify catalog counts unchanged. |
| Idempotency | Deterministic for the same catalog snapshot and task query | Deterministic score, sorted tie-break and bounded result count; catalog may change between calls. No write idempotency key required. |
| Error mapping | Node schema/argument errors wrapped as MCP tool errors | Schema failures and handler invariants become Rust MCP tool errors; exact Node error text/code compatibility is not claimed. |
| Response validation | Node returns a plain structured object; no universal result schema validator | Structured result is returned without per-tool output-schema validation. Rust includes explicit `limitations`, `compatible_profile_overlay_roles` and `profile_overlay_runtime_supported=false`; no semantic compatibility claim is inferred from score. |

## Remaining per-operation matrix coverage

The name tables above enumerate all 75 Node definitions by exact overlap and
Node-only status. The shared-operation summaries and cross-cutting contract table
do not yet constitute a complete per-operation mapping of all Node handler
branches, authorization/capability predicates, output validation and stable error
mapping. Those dimensions remain **unverified per operation** until each Node
`TOOL_DEFS` entry is traced to its handler and each Rust schema/handler is compared.
Do not treat a table row or exact-name match as completion of that work.

## Boundary and acceptance status

- `McpApplicationService` and `McpGateway` are transport-neutral contracts. The
  gateway imports no Runtime, Store, provider or execution crate and has negative
  tests for authorization-before-invocation, read-only routing, audience mismatch,
  response binding and oversized capability catalogs. If a mutating service call
  returns a transport error or an invalid/misbound response after invocation has
  begun, Gateway returns a request-bound `MUTATION_OUTCOME_UNKNOWN` response so
  callers reconcile before retrying; this does not establish commit success.
- The stdio `McpServer` still stores `Arc<WorkflowService>` and optional
  `Arc<Store>` and directly invokes them. It is **not independent** and must not
  be described as migrated.
- A concrete Part 1 `runalith-control-api` HTTP boundary now exists in the shared
  workspace. It authenticates opaque bearer credentials through a host-injected
  `ControlPrincipalVerifier`, derives capabilities from the authenticated
  principal, and routes workflow operations through `WorkflowService`. The
  current workspace snapshot passes `cargo fmt --all -- --check`,
  `cargo test --workspace --locked --offline`, and
  `cargo clippy --workspace --all-targets --locked --offline -- -D warnings`;
  the Control API crate contributes nine passing tests and the Worker crate
  contributes 49 library tests plus two binary tests. This validates the local
  library/client contracts, not independent deployment or production authority.
  Production verifiers/credentials and host composition are not supplied. The
  Worker has an HTTP client for Control routes, but no corresponding independent
  Execution application API or MCP-to-Control HTTP client adapter is present.
- The new Control API does not by itself migrate stdio: `McpServer` still stores
  `Arc<WorkflowService>` and optional `Arc<Store>` and directly invokes them.
  Do not describe the independent MCP boundary as migrated until stdio routes
  through a real authenticated service client and Execution ownership has a
  corresponding service contract.
- Node liveness parity is blocked by missing Rust runtime heartbeat/expiry
  inventory. Do not manufacture heartbeat values or classify missing lease data
  as worker death.
- `workflow_approve`, trust status, reviewer attestation ingestion and external
  checkpoint-linked evidence remain blocked on production authority and host
  composition. Tool registration cannot close those gates.
- `custom_workflow_clone` targeted regression passes. It creates a separate
  immutable definition and preserves exact role-version pins; no plan approval,
  workflow approval, execution authorization or dispatch is implied.
- `custom_role_clone` targeted regression passes. It verifies source definition
  digest and source skill-pin completeness, revalidates non-empty source pins with
  the host resolver, copies immutable pin snapshots in the same Store transaction,
  and requires a host resolver for replacement skills.

The Governance evidence-verification v1 and authenticated source-resolution v1
protocol contracts are internal cross-service contracts, not MCP tools. They do
not change the measured 75 Node / 62 Rust / 28 exact-name-overlap inventory and
do not make any `adaptive_goal_*` operation semantically equivalent. The
Execution resolver adapter, authenticated stdio Gateway integration and
per-operation Node/Rust differential coverage remain open.

The next independent-boundary step requires a host-owned Control API credential
resolver/client, authenticated transport principal source, service authorization
policy, idempotency store/contract and validated response schemas; the Execution
service API is still missing. Until those exist, continue only bounded operations
backed by real Rust service APIs and keep the stdio coupling gate open.
