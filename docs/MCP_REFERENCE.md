# MCP tool reference

This page is generated from the shipped stdio MCP server by the documentation generator. It describes registered tool names and input schemas returned by `tools/list`; it does not claim that every tool is safe in every workflow state. Follow the linked guides for lifecycle preconditions, permissions, evidence rules, and limitations.

- Source: `server/index-v1.0.9-rc.16.js` and its runtime schema definitions.
- Server identity reported by the checked-out source: `runalith-agent-orchestrator`.
- Source package version reported at generation time: `1.0.9-rc.16`. This is source-runtime metadata, not proof of which bundle is installed in a client.
- Registered tools: **74**.

## Choosing the right operation

- Use `workflow_catalog` to discover available built-in templates.
- Use `workflow_create` to make a proposal; it does not authorize execution.
- Explicitly approve the inspected proposal with `workflow_approve` before dispatch.
- Use `workflow_get`, `workflow_events`, `workflow_artifacts`, and `workflow_diagnose` to inspect durable state and investigate blocked work.
- The local dashboard is read-only; use MCP workflow tools for approved mutations.
- Tool schema validity is not permission to bypass approval, immutable-plan, artifact-provenance, or success-evaluation gates.

## Tool index

| Tool | Purpose | Required inputs |
|---|---|---|
| [`workflow_coordinator_role`](#workflow_coordinator_role) | Read the immutable built-in System Workflow Coordinator role used by the host assistant. It is not a custom role and cannot be created or modified through custom-role tools. | None |
| [`workflow_coordinator_step`](#workflow_coordinator_step) | Use as the normal high-level lifecycle interface after a proposal exists: it waits for explicit human approval, advances an already-approved workflow, prepares tasks, executes only approved deterministic local steps, and returns the next specialist task or synthesis contract. Submit task_result/synthesis to persist actual work. Do not use it to approve a proposal or bypass gates; use low-level tools for explicit state inspection or a documented recovery path. | `job_id` |
| [`orchestrator_health`](#orchestrator_health) | Read-only local health check for plugin/storage and local execution readiness. Use before diagnosing local setup problems; it never probes remote services and does not prove an individual workflow's evidence or success gates. | None |
| [`adaptive_goal_graph_search`](#adaptive_goal_graph_search) | Run bounded, read-only Adaptive Goal Graph nominal-success beam search and project complete candidates into review-only Plan Graph drafts. Returns deterministic expansion/pruning/lineage audit, explicit relation semantics, unverified evidence ledger, and unknown metrics as null. Candidates remain unverified; all execution and approval gates stay disabled. | `graph` |
| [`adaptive_goal_phase2_shadow_search`](#adaptive_goal_phase2_shadow_search) | Opt-in source-only Phase 2 learned-discriminator beam search. Set AGG_PHASE2_SHADOW_TOOL_ENABLED=1 to expose this tool in tools/list. Uses a caller-supplied self-hash-validated model and returns non-persisted Plan Graph shadow drafts. Model hash is not trusted provenance; metrics are not independently recomputed without examples. Never persists, approves, pins an execution plan, dispatches, or executes. | `graph`, `model` |
| [`adaptive_goal_phase3_mcts_shadow_search`](#adaptive_goal_phase3_mcts_shadow_search) | Opt-in source-only Phase 3 bounded UCT/MCTS over Idea Graph nominal transitions, guided by the caller-supplied Phase 2 discriminator. Set AGG_PHASE3_MCTS_TOOL_ENABLED=1 only for authorized shadow testing. Returns non-persisted review-only paths; the model self-hash is not trusted provenance, MCTS is non-exhaustive, and no result proves success/safety. Never persists, approves, dispatches, or executes. | `graph`, `model` |
| [`adaptive_goal_recovery_resolve`](#adaptive_goal_recovery_resolve) | Read-only, outcome-aware recovery recommendation for explicit recovers_to conditions. Requires the observed outcome and declared available prerequisite/evidence nodes; result remains not independently evidence-verified and never authorizes dispatch or execution. | `graph`, `context` |
| [`adaptive_goal_knowledge_node_save`](#adaptive_goal_knowledge_node_save) | Append or revise an Idea Graph node using a stable cross-goal identity, immutable revision history, canonical content/evidence-reference hash, required provenance, and expected-revision compare-and-swap. Caller-created knowledge always remains unverified and cannot become execution-ready through this tool. | `goal_id`, `stable_key`, `node_type`, `content`, `provenance` |
| [`adaptive_goal_knowledge_capture_workflow_outcome`](#adaptive_goal_knowledge_capture_workflow_outcome) | Opt-in source-only Phase 4 capture for authorized local testing. Set AGG_PHASE4_KNOWLEDGE_CAPTURE_TOOL_ENABLED=1 to expose the tool in tools/list. Captures bounded task/result/artifact metadata from a terminal local workflow and an optional caller-authored unverified lesson; rejects active jobs and malformed/oversized traces. Never verifies knowledge, authorizes execution, or dispatches. | `goal_id`, `job_id` |
| [`adaptive_goal_knowledge_edge_add`](#adaptive_goal_knowledge_edge_add) | Append a typed Idea Graph relation with provenance and stable edge identity. recovers_to edges require explicit condition and expected-outcome contracts; recovery relations are excluded from ordinary search by default. This tool never verifies claims or grants execution authority. | `goal_id`, `from_id`, `to_id`, `edge_type`, `provenance` |
| [`adaptive_goal_knowledge_search`](#adaptive_goal_knowledge_search) | Search the shared append-only Idea Graph across goals, including goal/hypothesis/idea/capability/experiment/evidence/condition nodes and cross-goal reuse memberships. This listing does not itself verify claims, current artifact lineage, or independence; use adaptive_goal_knowledge_snapshot_get and adaptive_goal_knowledge_graph_search to check a verifier-signed current snapshot. | None |
| [`adaptive_goal_knowledge_snapshot_get`](#adaptive_goal_knowledge_snapshot_get) | Read a complete canonical Goal/Idea Graph snapshot: current node revisions/content/provenance, immutable memberships and their provenance, edges/provenance, source references, integrity issues and exact snapshot hash. Resolves evidence through the live durable artifact/source verifiers and returns an explicit signed-attestation request. Hashes prove integrity, not claim truth; without a trusted verifier signature the graph is not eligible for planning. | `goal_id` |
| [`adaptive_goal_trust_configuration_status`](#adaptive_goal_trust_configuration_status) | Read-only for workflow, graph and approval state; records an observed valid trust configuration version/fingerprint in a separate append-only local ledger to prevent downgrade. Reports config version/fingerprint, public-root fingerprints, validity/revocation and administrator change metadata without exposing PEMs. Flags shared provider IDs or roots across source-verifier and reviewer domains. Configure through the host-supported administrator environment mechanism, never through MCP arguments. | None |
| [`adaptive_goal_knowledge_snapshot_attest`](#adaptive_goal_knowledge_snapshot_attest) | Persist an externally signed Ed25519 verification for the exact current Goal/Idea Graph snapshot. Requires the configured independent verifier provider/public trust root, current node/revision/edge/membership hashes, and freshly resolved successful producer/result/attempt/completion lineage. Claim truth and evidence independence are accepted only from the trusted signature; payloads from callers cannot self-promote. Uses a transactional append-only ledger with nonce/idempotency checks; never approves or dispatches. | `attestation` |
| [`adaptive_goal_knowledge_graph_search`](#adaptive_goal_knowledge_graph_search) | Run bounded search using only a freshly revalidated, trusted-attested persisted Goal/Idea Graph, not a caller-supplied graph. Requires the exact snapshot hash and persisted start/goal member IDs. Returns candidates and Plan Graph drafts bound to the current verifier attestation; any changed revision, membership, edge, source bytes, artifact lineage, nonce, signature, or expiry blocks planning. | `goal_id`, `start_node_id`, `goal_node_id`, `expected_snapshot_hash` |
| [`adaptive_goal_knowledge_node_get`](#adaptive_goal_knowledge_node_get) | Read the current or a specific immutable Idea Graph node revision, including its stable identity, cross-goal memberships, evidence refs, content hash, provenance hash, and unverified status. | `node_id` |
| [`adaptive_goal_knowledge_node_history`](#adaptive_goal_knowledge_node_history) | Read append-only revision history for a shared Idea Graph node. Each revision preserves its own canonical content/evidence refs/hash/provenance and remains unverified. | `node_id` |
| [`adaptive_goal_knowledge_recovery_resolve`](#adaptive_goal_knowledge_recovery_resolve) | Read-only outcome-aware recovery check for a persisted Idea Graph recovers_to edge. Requires explicit matching outcome plus active durable artifact evidence whose hash, producer, result, and completion lineage verifies and whose structured content declares the same outcome. Returns review-only routes; never executes, approves, or dispatches. | `goal_id`, `source_node_id`, `observed_outcome`, `evidence_refs` |
| [`adaptive_goal_plan_compatibility_check`](#adaptive_goal_plan_compatibility_check) | Read-only compatibility assessment for an unverified AGG Plan Graph draft against a compiled supported workflow template using explicit step-to-task bindings. Reports dependency/template blockers only; never creates a workflow proposal, persists a plan, approves, authorizes, dispatches, or executes. | `draft`, `workflow_id`, `task_bindings` |
| [`adaptive_goal_plan_proposal_create`](#adaptive_goal_plan_proposal_create) | Create a review-only Plan Graph proposal from a freshly revalidated candidate using explicit step-to-task bindings. Legacy graph arguments remain caller-supplied shadow inputs and cannot authorize downstream Execution Graph creation. Verified mode omits graph and supplies knowledge_goal_id/start/goal node IDs plus exact knowledge_snapshot_hash; the runtime rebuilds the graph from its append-only store, verifies the current external attestation and durable evidence lineage, and binds its attestation/snapshot hashes into the draft, fingerprint and durable proposal. Creates a PROPOSED review wrapper only; human approval still does not grant AGG action authority. | `candidate_plan_id`, `workflow_id`, `task_bindings` |
| [`adaptive_goal_plan_proposal_get`](#adaptive_goal_plan_proposal_get) | Read back and revalidate the exact AGG proposal snapshot (source graph, candidate-derived Plan Graph draft, draft/mapping hashes, and structural template compatibility). Read-only; it does not alter workflow state, approve, dispatch, or execute. | `job_id` |
| [`adaptive_goal_execution_readiness_check`](#adaptive_goal_execution_readiness_check) | Read-only assessment of explicit AGG action-to-task mappings against immutable role capability/input/output artifact contracts, compiled dependency ancestry, and durable artifact/evidence lineage. It distinguishes contract readiness from source-evidence readiness and never creates an Execution Graph or executable contract, grants permissions, approves, dispatches, or executes. | `draft`, `workflow_id`, `task_bindings` |
| [`adaptive_goal_execution_graph_proposal_create`](#adaptive_goal_execution_graph_proposal_create) | Create a persisted, review-only Execution Graph proposal from a stored Plan Graph proposal after revalidating its candidate, exact draft/bindings, role/capability contracts, DAG ancestry, active durable artifact/event lineage, producer completion, schema versions and hashes. Requires readiness to pass; otherwise returns stable blockers without writing a job. A successful result creates only a PROPOSED standard-engineering review wrapper, never executable contracts, task rows, approval, dispatch or execution. | `plan_proposal_job_id`, `task_bindings` |
| [`adaptive_goal_execution_graph_proposal_get`](#adaptive_goal_execution_graph_proposal_get) | Read back and revalidate a stored Execution Graph proposal against its source Plan Graph proposal and current durable artifact evidence. Reports stale hashes, changed workflow contracts or invalidated evidence as stable blockers. Read-only; never pins plans, approves, dispatches or executes. | `job_id` |
| [`adaptive_goal_execution_plan_candidate_create`](#adaptive_goal_execution_plan_candidate_create) | Validate and persist a review-only execution-plan candidate using the existing workflow compiler, validateExecutionPlan and exact preflight plan hash. The versioned semantic policy checks each role capability, canonical operation, target binding, artifact output type, exact role completion criteria and canonical description; arbitrary/free-form instructions and unresolved targets are rejected. Reviewer identity is not inferred from caller-supplied reviewerId: the candidate remains blocked until a trusted Ed25519 identity provider attestation is durably recorded and verified against the configured public trust root and exact candidate/semantic/role-contract/immutable-plan fingerprints. Candidate creation writes only a bounded candidate event; it never approves, pins workflow_plans, creates tasks, dispatches, grants execution authorization or generates commands/arguments. | `job_id`, `reviewed_action_intents` |
| [`adaptive_goal_execution_plan_candidate_get`](#adaptive_goal_execution_plan_candidate_get) | Read-only rebuild and revalidation of the persisted review-only candidate, exact action-intent semantics, typed input/evidence/ancestor provenance, role/artifact contracts, current source evidence, compiler and plan hashes. Reports tampering/staleness and trust-root-verified reviewer status. Without a valid, unexpired, replay-free identity-provider attestation bound to the exact candidate and immutable-plan fingerprints, the reviewer identity blocker remains and approval/dispatch/task preparation are denied. This tool does not refresh snapshots, approve, pin plans, create tasks or dispatch. | `job_id` |
| [`adaptive_goal_sandbox_action_execute`](#adaptive_goal_sandbox_action_execute) | Experimental/test-only executor for one hard-coded, no-network fixture action. Requires a current trust-root-verified reviewer attestation, explicit workflow approval, exact immutable compiler plan, dispatched active workflow, completed task prerequisites, and current typed artifact/result/completion lineage. Executes no caller-supplied command, script, or path. Refuses production mode, missing/tampered evidence, unsupported action, unresolved prior claims, and replay; repeated requests can only read the exact already-verified receipt without re-executing. This tool never grants approval or production execution authority. | `job_id`, `task_id` |
| [`workflow_catalog`](#workflow_catalog) | Read-only discovery of supported local workflow templates, exact workflow IDs/versions and intended execution modes. Use first when choosing a template; then workflow_create and workflow_preflight. This does not create, approve, or run a workflow. | None |
| [`workflow_recommend_resources`](#workflow_recommend_resources) | Proactive, read-only discovery for a task goal. Use before creating a substantial workflow even when the user did not name roles, policies, skills, or reusable workflows. Ranks saved custom workflows, custom roles/attached skills, saved policies, and built-in role hints using deterministic Vietnamese/English lexical matching. Prefer compatible high-confidence existing resources over near-duplicates, but inspect contracts and policy scope; lexical scores are hints, not semantic proof. Does not attach policies, bind roles, mutate storage, approve, or execute. | `task` |
| [`workflow_policy_catalog`](#workflow_policy_catalog) | Read-only discovery of policy predicate types and their real runtime enforcement points. Use before drafting a policy; do not invent predicates or treat a catalog entry as proof a policy is attached/enforced for a particular run. | None |
| [`workflow_policy_create`](#workflow_policy_create) | State-changing: create immutable version 1 of a reusable workflow policy pack after reviewing workflow_policy_catalog. Use only the closed predicate schema; no executable code/arbitrary expressions are accepted. Validate before attaching; creation alone does not attach the policy to a workflow. | `policy_id`, `name` |
| [`workflow_policy_list`](#workflow_policy_list) | Read-only list/search of saved policy packs. Set include_versions when comparing immutable revisions; use workflow_policy_get for a specific pack. This does not validate or attach a policy. | None |
| [`workflow_policy_get`](#workflow_policy_get) | Read-only inspection of a policy pack's latest or exact immutable version and workflows that pin it. Use to verify the intended revision/attachments before changes; it does not attach or update anything. | `policy_id` |
| [`workflow_policy_update`](#workflow_policy_update) | State-changing: create the next immutable version of an existing policy pack. Omitted fields are retained; old versions and plans already pinned to them do not change. Validate the new version and explicitly attach an exact version to an eligible unapproved proposal if needed. | `policy_id` |
| [`workflow_policy_validate`](#workflow_policy_validate) | Read-only validation of a proposed policy pack without storing it. Checks closed schema, rule conflicts and policy-level invariants; target-plan compatibility is checked again when attaching. Use before create/update/attach; a valid policy is not yet attached or enforced. | `policy_id`, `name` |
| [`workflow_policy_attach`](#workflow_policy_attach) | State-changing: attach an exact policy version only to an active, unapproved workflow proposal. The snapshot is pinned into the later plan hash; attachment is prohibited after approval/compilation. Use after policy validation and before workflow_approve; create a new proposal if the plan is already approved. | `job_id`, `policy_id` |
| [`workflow_create`](#workflow_create) | Create a proposal only. Optional role_bindings pin immutable role-profile snapshots. For workspace edits, declare required_operations:["workspace.write"] plus explicit role-specific relative scopes (only built-in engineer/writer on standard-engineering v3+); scopes grant neither shell access nor unscoped filesystem access. Next call workflow_preflight, inspect the immutable plan/readiness, then obtain explicit human approval. Creation never approves or executes. | `title`, `task` |
| [`workflow_list`](#workflow_list) | Read-only list of locally stored active workflows. Use to find a job_id when it is not known, then inspect that run with workflow_get; this does not advance or mutate any workflow. | None |
| [`workflow_get`](#workflow_get) | Read-only inspection of local workflow state, immutable plan/hash, task states, artifact metadata and phase. Use before approval or when diagnosing a specific job; it does not expose full result bodies or mutate state. | `job_id` |
| [`workflow_liveness_diagnostics`](#workflow_liveness_diagnostics) | Read-only diagnosis of active-job liveness using durable job/task/event timestamps and task-lease heartbeats/expiry. Reports stale candidates and safe inspection hints; old activity is not proof a worker is dead. Never changes job/task state, expires or reacquires leases, retries, dispatches, or grants permission. | None |
| [`workflow_preflight`](#workflow_preflight) | Read-only feasibility check of a proposal or approved immutable plan. Compiles in memory without creating/changing a plan, checks workflow/version compatibility, role capability/permission contracts, scoped workspace-write roots, and plan/hash consistency. Run before workflow_approve; approval independently repeats the gate. A ready result is not approval or execution. | `job_id` |
| [`workflow_approve`](#workflow_approve) | State-changing approval: use only after workflow_preflight is ready, the proposal and proposed immutable plan are inspected, and explicit human approval is obtained. Re-runs feasibility checks, then pins the plan; do not edit it in place afterward. Approval is not dispatch—call workflow_dispatch next. | `job_id`, `confirmation` |
| [`workflow_dispatch`](#workflow_dispatch) | State-changing dispatch: use only for a proposal already approved with a current immutable plan. Starts the local workflow and creates its durable coordinator task; no cloud/remote worker is contacted. Then prepare tasks or use workflow_coordinator_step to advance. | `job_id` |
| [`workflow_prepare_tasks`](#workflow_prepare_tasks) | State-changing task preparation/recovery: use after workflow_dispatch when the immutable plan's child tasks need creating or reconciling. Safe to repeat for the same approved plan; does not execute tasks. Next call workflow_next_task or workflow_coordinator_step. | `job_id` |
| [`workflow_next_task`](#workflow_next_task) | Use after task preparation and after each recorded completion to obtain the next dependency-ready task, exact role contract and predecessor evidence. Deterministic tasks must use the approved task_execute_local/execute_batch path; specialist reasoning tasks use workflow_complete_task. If no task is ready or a gate blocks progress, inspect/diagnose rather than inventing a result. | `job_id` |
| [`workflow_diagnose`](#workflow_diagnose) | Read-only diagnosis when a local workflow is blocked, stuck, failed, or unexpectedly pending. Correlates task states, reviewer findings, stale/missing artifacts and safe next actions; it never mutates state. Use diagnosis before authorized rework/reviewer revision and never treat it as a repair or gate bypass. | `job_id` |
| [`workflow_request_rework`](#workflow_request_rework) | State-changing review recovery, supported only when the exact immutable plan has workflow_id=standard-engineering and workflow_version>=2, and the job is active/EXECUTING with current approval. engineering@2 is not compatible. Use workflow_diagnose first; unsupported plans need a new proposal and approval, not retries. Rework preserves the immutable plan and approval gates and does not complete work. | `job_id`, `reason` |
| [`workflow_request_reviewer_revision`](#workflow_request_reviewer_revision) | Narrow review recovery, supported only for workflow_id=standard-engineering and version>=2 in an active/EXECUTING job with current approval; use only for an accepted review blocked solely by evidenceIssues when all other acceptance flags/findings pass. engineering@2 is not compatible. Does not approve synthesis or weaken the contract. | `job_id`, `reason` |
| [`workflow_complete_task`](#workflow_complete_task) | State-changing completion for a currently issued, dependency-ready non-deterministic local specialist task. Persist the actual result and typed artifact; record outcome=failed when work failed. Do not fabricate results or use this for deterministic tasks, which require task_execute_local/execute_batch. Request the next task after completion. | `task_id`, `content`, `artifact` |
| [`task_execute_local`](#task_execute_local) | State-changing local execution for one prepared deterministic task whose executable, arguments and workspace are fixed by the approved immutable plan. Do not use this route for any task whose immutable batch policy requires execute_batch, even for a single-item batch. No arbitrary commands or remote execution are accepted. Inspect the actual exit/output and then request the next task. | `task_id` |
| [`workflow_write_files`](#workflow_write_files) | State-changing, scope-limited workspace edit for a currently running built-in engineer/writer child of an approved standard-engineering v3+ workflow. Only plan-pinned relative paths are writable; each file must provide base_sha256 or ABSENT, and patch_id makes retries idempotent. No arbitrary commands, deletions, renames, symlink traversal, directory creation, custom roles or caller-supplied workspace roots. Inspect per-file receipts; reference receipt IDs in the typed task artifact. A multi-file patch can partially apply and will report that explicitly. | `job_id`, `task_id`, `patch_id`, `writes` |
| [`execute_batch`](#execute_batch) | State-changing batch execution for 1–32 prepared, dependency-ready deterministic tasks within one approved active workflow. Use only tasks authorized for ExecutionManager; each is resolved from the immutable plan, and callers cannot supply command/args/cwd/timeout/role. Do not use for specialist reasoning tasks; inspect per-task outcomes and recover failures through the documented path. | `job_id`, `task_ids` |
| [`workflow_complete_synthesis`](#workflow_complete_synthesis) | State-changing finalization: use only when all required tasks and evidence are ready and the coordinator has returned the synthesis contract. Record the typed CTO decision and exact success_assessment IDs/evidence_refs; the runtime independently checks task state, lineage, reviewer/QA gates and predicates. A call or narrative cannot bypass a failed gate; CASE-01 also requires the exact consumed workspace bytes. | `job_id`, `content`, `artifact` |
| [`workflow_events`](#workflow_events) | Read-only view of a workflow's durable event history and observability summary. Use to reconstruct ordering or investigate an unexpected state; it does not change task/job state. Pair with workflow_get or workflow_diagnose when needed. | `job_id` |
| [`workflow_artifacts`](#workflow_artifacts) | Read-only listing of persisted typed artifacts and their metadata/status for a local workflow; content is redacted and bounded. Use to check artifact presence/lineage before review or synthesis, not as a replacement for schema/provenance validation. | `job_id` |
| [`workflow_e2e_run`](#workflow_e2e_run) | State-changing convenience runner for deterministic local steps of an already-approved workflow. Use only when advancing deterministic tasks without host reasoning is sufficient; it never fabricates specialist results, approves a proposal, or self-approves synthesis. Use the coordinator/next-task path when specialist work is required. | `job_id` |
| [`workflow_recovery_verify`](#workflow_recovery_verify) | Read-only post-recovery check of persisted workflow invariants using an independent fresh Node process against the same SQLite database. Use to verify stored-state consistency; this does not prove runtime correctness, a supervisor restart, or external service health. | `job_id` |
| [`workflow_record_intervention`](#workflow_record_intervention) | State-changing audit note for a real manual intervention/workaround, capturing reason and what was done for future automation. Use only after an actual intervention; it does not change workflow state, approval, or security policy and must not be used to manufacture evidence. | `reason`, `workaround` |
| [`workflow_interventions`](#workflow_interventions) | Read-only query of previously recorded manual interventions, optionally scoped to a workflow. Use for operational learning; it does not apply or validate a workaround. | None |
| [`workflow_validate_artifact`](#workflow_validate_artifact) | Read-only validation of typed artifact content against a known schema/optional role. Use before persisting a candidate artifact to catch missing/invalid fields; this alone does not persist it or prove task-result lineage, approval, or overall workflow success. | `artifact_type`, `artifact` |
| [`workflow_access_diagnostics`](#workflow_access_diagnostics) | Read-only local diagnostics for trust/config clues relevant to CHAT_NOT_TRUSTED. Use to investigate the underlying configuration; it never bypasses or changes trust policy. | None |
| [`custom_role_create`](#custom_role_create) | State-changing creation of immutable custom role version 1. Use when a reusable specialist definition is needed; optional local Agent Skills directories/public GitHub URLs are validated and snapshotted. Treat attached skill text as supplementary, review permissions separately, and do not assume role declarations grant runtime access. | `role_id`, `name`, `description`, `system_prompt`, `input_contract`, `output_artifact_type` |
| [`custom_role_update`](#custom_role_update) | State-changing creation of the next immutable custom-role version; omitted fields (including skills) are retained, while skills: [] removes attachments. Existing workflow plans keep their pinned snapshots. Inspect the resulting version and use it only in newly compiled plans when appropriate. | `role_id` |
| [`custom_role_get`](#custom_role_get) | Read-only inspection of the latest or an exact immutable custom-role version and its pinned skill metadata. Use to verify the definition before cloning or binding; this does not update permissions or grant runtime access. | `role_id` |
| [`custom_role_list`](#custom_role_list) | Read-only list of custom roles; set include_versions to inspect immutable history. Use custom_role_get to inspect one role's content. This does not create or change roles. | None |
| [`custom_role_clone`](#custom_role_clone) | State-changing clone into a new custom-role ID. The clone preserves pinned skill snapshots unless replacement skills are supplied; review its full definition/permissions and remember its declarations do not grant runtime tool access. | `source_role_id`, `role_id` |
| [`custom_workflow_create`](#custom_workflow_create) | State-changing creation of immutable custom-workflow definition version 1. Use only after checking dependencies/input-output contracts; creation does not produce an executable run. Call custom_workflow_preview to compile and inspect the pinned plan before explicit approval. | `workflow_id`, `name`, `description`, `input_contract`, `tasks` |
| [`custom_workflow_update`](#custom_workflow_update) | State-changing creation of the next immutable custom-workflow definition version; provide the complete definition. Existing previews/runs keep pinned versions. Preview and inspect the new version before approving a run from it. | `workflow_id`, `name`, `description`, `input_contract`, `tasks` |
| [`custom_workflow_get`](#custom_workflow_get) | Read-only inspection of the latest or exact immutable custom-workflow definition version. Use before preview/clone/update to verify task graph and contract; this does not execute it. | `workflow_id` |
| [`custom_workflow_list`](#custom_workflow_list) | Read-only list/search of custom workflow definitions; include_versions shows immutable history. Use custom_workflow_get to inspect a specific definition; listing does not validate or execute it. | None |
| [`custom_workflow_clone`](#custom_workflow_clone) | State-changing clone into a new custom-workflow ID. Cloned tasks retain pinned custom-role versions unless a complete revised definition is supplied; preview and inspect the clone before approval or execution. | `source_workflow_id`, `workflow_id` |
| [`custom_workflow_preview`](#custom_workflow_preview) | State-changing preview creation: compile and persist an immutable custom-workflow plan with pinned role versions, validated dependencies, and hash. Review the preview before custom_workflow_approve; this does not create/approve/execute a workflow run. | `workflow_id` |
| [`custom_workflow_approve`](#custom_workflow_approve) | State-changing approval of the exact immutable custom-workflow preview after inspection and explicit user confirmation. This approves the definition preview only; custom_workflow_run_create and a separate workflow_approve for the resulting run are still required before dispatch. | `plan_id`, `confirmation` |
| [`custom_workflow_run_create`](#custom_workflow_run_create) | State-changing creation of a local run proposal from an already-approved immutable custom-workflow preview. Add run-specific goal/constraints/success criteria here; inspect the proposal, then call workflow_approve for the run and dispatch only after approval. This call itself does not dispatch or execute. | `plan_id`, `title`, `request` |

## Tool schemas

The expandable schema block under each tool contains the exact JSON Schema returned by the server. Input schemas describe shape and constraints; runtime state, authorization, and evidence checks are enforced separately.

### `workflow_coordinator_role`

Read the immutable built-in System Workflow Coordinator role used by the host assistant. It is not a custom role and cannot be created or modified through custom-role tools.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

</details>

### `workflow_coordinator_step`

Use as the normal high-level lifecycle interface after a proposal exists: it waits for explicit human approval, advances an already-approved workflow, prepares tasks, executes only approved deterministic local steps, and returns the next specialist task or synthesis contract. Submit task_result/synthesis to persist actual work. Do not use it to approve a proposal or bypass gates; use low-level tools for explicit state inspection or a documented recovery path.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `task_result` | `object` | No | — | no additional properties; required fields: `task_id`, `content`, `artifact` |
| `synthesis` | `object` | No | — | no additional properties; required fields: `content`, `artifact` |
| `max_local_steps` | `integer` | No | — | minimum: `1`; maximum: `20`; default: `5` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "task_result": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "task_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000000
        },
        "artifact": {
          "type": "object"
        },
        "outcome": {
          "type": "string",
          "enum": [
            "success",
            "failed"
          ],
          "default": "success"
        }
      },
      "required": [
        "task_id",
        "content",
        "artifact"
      ]
    },
    "synthesis": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "content": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000000
        },
        "artifact": {
          "type": "object"
        },
        "consumed_workspace_bytes": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "path": {
                "type": "string",
                "enum": [
                  "config.json",
                  "result.json"
                ]
              },
              "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "encoding": {
                "type": "string",
                "enum": [
                  "base64"
                ]
              },
              "bytes": {
                "type": "string",
                "maxLength": 2000000
              }
            },
            "required": [
              "path",
              "sha256",
              "encoding",
              "bytes"
            ]
          }
        }
      },
      "required": [
        "content",
        "artifact"
      ]
    },
    "max_local_steps": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20,
      "default": 5
    }
  },
  "required": [
    "job_id"
  ]
}
```

</details>

### `orchestrator_health`

Read-only local health check for plugin/storage and local execution readiness. Use before diagnosing local setup problems; it never probes remote services and does not prove an individual workflow's evidence or success gates.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

</details>

### `adaptive_goal_graph_search`

Run bounded, read-only Adaptive Goal Graph nominal-success beam search and project complete candidates into review-only Plan Graph drafts. Returns deterministic expansion/pruning/lineage audit, explicit relation semantics, unverified evidence ledger, and unknown metrics as null. Candidates remain unverified; all execution and approval gates stay disabled.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `graph` | `object` | Yes | — | no additional properties; required fields: `schemaVersion`, `startNodeId`, `goalNodeId`, `nodes`, `edges` |
| `knowledge_goal_id` | `string` | No | — | minLength: `1`; maxLength: `200` |
| `knowledge_node_ids` | `array` | No | — | maxItems: `499`; unique items; items: string |
| `knowledge_bindings` | `array` | No | — | maxItems: `1000`; items: object |
| `options` | `object` | No | — | no additional properties |
| `plan_projection_options` | `object` | No | — | no additional properties |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "graph": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "startNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "goalNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "goal",
                  "idea",
                  "hypothesis",
                  "candidate",
                  "experiment",
                  "capability",
                  "evidence",
                  "condition",
                  "task"
                ]
              },
              "label": {
                "type": "string",
                "maxLength": 500
              },
              "estimatedCost": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1000000000
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedRisk": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedSuccessConfidence": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "reusePotential": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "informationValue": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "metricProvenance": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "estimatedCost": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedRisk": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedSuccessConfidence": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "reusePotential": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "informationValue": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  }
                }
              },
              "evidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              }
            },
            "required": [
              "id",
              "type"
            ]
          }
        },
        "edges": {
          "type": "array",
          "maxItems": 2000,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "from": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "to": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "next_step",
                  "requires_all",
                  "depends_on",
                  "supports",
                  "alternative_to",
                  "enables",
                  "tested_by",
                  "contradicts",
                  "recovers_to"
                ]
              },
              "condition": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "onOutcome": {
                    "type": "string",
                    "enum": [
                      "failed",
                      "blocked",
                      "verification_failed",
                      "evidence_missing",
                      "contradicted"
                    ]
                  },
                  "requiresEvidenceNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  },
                  "requiresAllNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  }
                },
                "required": [
                  "onOutcome",
                  "requiresEvidenceNodeIds",
                  "requiresAllNodeIds"
                ]
              }
            },
            "required": [
              "from",
              "to",
              "type"
            ]
          }
        }
      },
      "required": [
        "schemaVersion",
        "startNodeId",
        "goalNodeId",
        "nodes",
        "edges"
      ]
    },
    "knowledge_goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "knowledge_node_ids": {
      "type": "array",
      "maxItems": 499,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80,
        "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
      }
    },
    "knowledge_bindings": {
      "type": "array",
      "maxItems": 1000,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "from_node_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          },
          "to_node_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          },
          "edge_type": {
            "type": "string",
            "enum": [
              "next_step",
              "requires_all",
              "depends_on",
              "supports",
              "alternative_to",
              "enables",
              "tested_by",
              "contradicts"
            ]
          }
        },
        "required": [
          "from_node_id",
          "to_node_id",
          "edge_type"
        ]
      }
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "maxDepth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "beamWidth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "maxExpansions": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10000
        },
        "maxAuditEvents": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5000
        },
        "initiallyAvailableIds": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        }
      }
    },
    "plan_projection_options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "dependencyMode": {
          "type": "string",
          "enum": [
            "sequential_path",
            "source_edges_only"
          ]
        }
      }
    }
  },
  "required": [
    "graph"
  ]
}
```

</details>

### `adaptive_goal_phase2_shadow_search`

Opt-in source-only Phase 2 learned-discriminator beam search. Set AGG_PHASE2_SHADOW_TOOL_ENABLED=1 to expose this tool in tools/list. Uses a caller-supplied self-hash-validated model and returns non-persisted Plan Graph shadow drafts. Model hash is not trusted provenance; metrics are not independently recomputed without examples. Never persists, approves, pins an execution plan, dispatches, or executes.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `graph` | `object` | Yes | — | no additional properties; required fields: `schemaVersion`, `startNodeId`, `goalNodeId`, `nodes`, `edges` |
| `model` | `object` | Yes | — | required fields: `schemaVersion`, `featureSchemaVersion`, `modelType`, `modelSha256` |
| `options` | `object` | No | — | no additional properties |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "graph": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "startNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "goalNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "goal",
                  "idea",
                  "hypothesis",
                  "candidate",
                  "experiment",
                  "capability",
                  "evidence",
                  "condition",
                  "task"
                ]
              },
              "label": {
                "type": "string",
                "maxLength": 500
              },
              "estimatedCost": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1000000000
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedRisk": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedSuccessConfidence": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "reusePotential": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "informationValue": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "metricProvenance": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "estimatedCost": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedRisk": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedSuccessConfidence": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "reusePotential": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "informationValue": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  }
                }
              },
              "evidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              }
            },
            "required": [
              "id",
              "type"
            ]
          }
        },
        "edges": {
          "type": "array",
          "maxItems": 2000,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "from": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "to": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "next_step",
                  "requires_all",
                  "depends_on",
                  "supports",
                  "alternative_to",
                  "enables",
                  "tested_by",
                  "contradicts",
                  "recovers_to"
                ]
              },
              "condition": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "onOutcome": {
                    "type": "string",
                    "enum": [
                      "failed",
                      "blocked",
                      "verification_failed",
                      "evidence_missing",
                      "contradicted"
                    ]
                  },
                  "requiresEvidenceNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  },
                  "requiresAllNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  }
                },
                "required": [
                  "onOutcome",
                  "requiresEvidenceNodeIds",
                  "requiresAllNodeIds"
                ]
              }
            },
            "required": [
              "from",
              "to",
              "type"
            ]
          }
        }
      },
      "required": [
        "schemaVersion",
        "startNodeId",
        "goalNodeId",
        "nodes",
        "edges"
      ]
    },
    "model": {
      "type": "object",
      "maxProperties": 20,
      "additionalProperties": true,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            2
          ]
        },
        "featureSchemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "modelType": {
          "type": "string",
          "enum": [
            "standardized-logistic-regression"
          ]
        },
        "modelSha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "schemaVersion",
        "featureSchemaVersion",
        "modelType",
        "modelSha256"
      ]
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "maxDepth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 40
        },
        "beamWidth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 8
        },
        "maxExpansions": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2000
        },
        "maxAuditEvents": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000
        },
        "initiallyAvailableIds": {
          "type": "array",
          "maxItems": 500,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        }
      }
    }
  },
  "required": [
    "graph",
    "model"
  ]
}
```

</details>

### `adaptive_goal_phase3_mcts_shadow_search`

Opt-in source-only Phase 3 bounded UCT/MCTS over Idea Graph nominal transitions, guided by the caller-supplied Phase 2 discriminator. Set AGG_PHASE3_MCTS_TOOL_ENABLED=1 only for authorized shadow testing. Returns non-persisted review-only paths; the model self-hash is not trusted provenance, MCTS is non-exhaustive, and no result proves success/safety. Never persists, approves, dispatches, or executes.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `graph` | `object` | Yes | — | no additional properties; required fields: `schemaVersion`, `startNodeId`, `goalNodeId`, `nodes`, `edges` |
| `model` | `object` | Yes | — | required fields: `schemaVersion`, `featureSchemaVersion`, `modelType`, `modelSha256` |
| `options` | `object` | No | — | no additional properties |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "graph": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "startNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "goalNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "goal",
                  "idea",
                  "hypothesis",
                  "candidate",
                  "experiment",
                  "capability",
                  "evidence",
                  "condition",
                  "task"
                ]
              },
              "label": {
                "type": "string",
                "maxLength": 500
              },
              "estimatedCost": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1000000000
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedRisk": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedSuccessConfidence": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "reusePotential": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "informationValue": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "metricProvenance": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "estimatedCost": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedRisk": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedSuccessConfidence": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "reusePotential": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "informationValue": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  }
                }
              },
              "evidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              }
            },
            "required": [
              "id",
              "type"
            ]
          }
        },
        "edges": {
          "type": "array",
          "maxItems": 2000,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "from": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "to": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "next_step",
                  "requires_all",
                  "depends_on",
                  "supports",
                  "alternative_to",
                  "enables",
                  "tested_by",
                  "contradicts",
                  "recovers_to"
                ]
              },
              "condition": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "onOutcome": {
                    "type": "string",
                    "enum": [
                      "failed",
                      "blocked",
                      "verification_failed",
                      "evidence_missing",
                      "contradicted"
                    ]
                  },
                  "requiresEvidenceNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  },
                  "requiresAllNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  }
                },
                "required": [
                  "onOutcome",
                  "requiresEvidenceNodeIds",
                  "requiresAllNodeIds"
                ]
              }
            },
            "required": [
              "from",
              "to",
              "type"
            ]
          }
        }
      },
      "required": [
        "schemaVersion",
        "startNodeId",
        "goalNodeId",
        "nodes",
        "edges"
      ]
    },
    "model": {
      "type": "object",
      "maxProperties": 20,
      "additionalProperties": true,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            2
          ]
        },
        "featureSchemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "modelType": {
          "type": "string",
          "enum": [
            "standardized-logistic-regression"
          ]
        },
        "modelSha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "schemaVersion",
        "featureSchemaVersion",
        "modelType",
        "modelSha256"
      ]
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "maxSimulations": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000
        },
        "maxDepth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 40
        },
        "maxExpansions": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2000
        },
        "maxWorkUnits": {
          "type": "integer",
          "minimum": 2,
          "maximum": 250000
        },
        "maxAuditEvents": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000
        },
        "candidateLimit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "maxTreeNodes": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2000
        },
        "maxTerminalPaths": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000
        },
        "explorationConstant": {
          "type": "number",
          "minimum": 0,
          "maximum": 10
        },
        "seed": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "initiallyAvailableIds": {
          "type": "array",
          "maxItems": 500,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        }
      }
    }
  },
  "required": [
    "graph",
    "model"
  ]
}
```

</details>

### `adaptive_goal_recovery_resolve`

Read-only, outcome-aware recovery recommendation for explicit recovers_to conditions. Requires the observed outcome and declared available prerequisite/evidence nodes; result remains not independently evidence-verified and never authorizes dispatch or execution.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `graph` | `object` | Yes | — | no additional properties; required fields: `schemaVersion`, `startNodeId`, `goalNodeId`, `nodes`, `edges` |
| `context` | `object` | Yes | — | no additional properties; required fields: `sourceNodeId`, `outcome`, `availableNodeIds`, `availableEvidenceNodeIds` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "graph": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "startNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "goalNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "goal",
                  "idea",
                  "hypothesis",
                  "candidate",
                  "experiment",
                  "capability",
                  "evidence",
                  "condition",
                  "task"
                ]
              },
              "label": {
                "type": "string",
                "maxLength": 500
              },
              "estimatedCost": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1000000000
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedRisk": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedSuccessConfidence": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "reusePotential": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "informationValue": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "metricProvenance": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "estimatedCost": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedRisk": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedSuccessConfidence": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "reusePotential": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "informationValue": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  }
                }
              },
              "evidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              }
            },
            "required": [
              "id",
              "type"
            ]
          }
        },
        "edges": {
          "type": "array",
          "maxItems": 2000,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "from": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "to": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "next_step",
                  "requires_all",
                  "depends_on",
                  "supports",
                  "alternative_to",
                  "enables",
                  "tested_by",
                  "contradicts",
                  "recovers_to"
                ]
              },
              "condition": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "onOutcome": {
                    "type": "string",
                    "enum": [
                      "failed",
                      "blocked",
                      "verification_failed",
                      "evidence_missing",
                      "contradicted"
                    ]
                  },
                  "requiresEvidenceNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  },
                  "requiresAllNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  }
                },
                "required": [
                  "onOutcome",
                  "requiresEvidenceNodeIds",
                  "requiresAllNodeIds"
                ]
              }
            },
            "required": [
              "from",
              "to",
              "type"
            ]
          }
        }
      },
      "required": [
        "schemaVersion",
        "startNodeId",
        "goalNodeId",
        "nodes",
        "edges"
      ]
    },
    "context": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sourceNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "outcome": {
          "type": "string",
          "enum": [
            "failed",
            "blocked",
            "verification_failed",
            "evidence_missing",
            "contradicted"
          ]
        },
        "availableNodeIds": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        },
        "availableEvidenceNodeIds": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        }
      },
      "required": [
        "sourceNodeId",
        "outcome",
        "availableNodeIds",
        "availableEvidenceNodeIds"
      ]
    }
  },
  "required": [
    "graph",
    "context"
  ]
}
```

</details>

### `adaptive_goal_knowledge_node_save`

Append or revise an Idea Graph node using a stable cross-goal identity, immutable revision history, canonical content/evidence-reference hash, required provenance, and expected-revision compare-and-swap. Caller-created knowledge always remains unverified and cannot become execution-ready through this tool.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `goal_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `stable_key` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `node_type` | `string` | Yes | — | enum: `goal`, `hypothesis`, `idea`, `capability`, `experiment`, `evidence`, `condition` |
| `content` | `object` | Yes | — | — |
| `provenance` | `object` | Yes | — | no additional properties; required fields: `source`, `actor` |
| `expected_revision` | `integer` | No | — | minimum: `0` |
| `evidence_refs` | `array` | No | — | maxItems: `64`; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "stable_key": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "node_type": {
      "type": "string",
      "enum": [
        "goal",
        "hypothesis",
        "idea",
        "capability",
        "experiment",
        "evidence",
        "condition"
      ]
    },
    "content": {
      "type": "object",
      "additionalProperties": true,
      "maxProperties": 256
    },
    "provenance": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "source": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        },
        "actor": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "reference": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        },
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        }
      },
      "required": [
        "source",
        "actor"
      ]
    },
    "expected_revision": {
      "type": "integer",
      "minimum": 0
    },
    "evidence_refs": {
      "type": "array",
      "maxItems": 64,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      }
    }
  },
  "required": [
    "goal_id",
    "stable_key",
    "node_type",
    "content",
    "provenance"
  ]
}
```

</details>

### `adaptive_goal_knowledge_capture_workflow_outcome`

Opt-in source-only Phase 4 capture for authorized local testing. Set AGG_PHASE4_KNOWLEDGE_CAPTURE_TOOL_ENABLED=1 to expose the tool in tools/list. Captures bounded task/result/artifact metadata from a terminal local workflow and an optional caller-authored unverified lesson; rejects active jobs and malformed/oversized traces. Never verifies knowledge, authorizes execution, or dispatches.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `goal_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `lesson` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `expected_revision` | `integer` | No | — | minimum: `0` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "lesson": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "expected_revision": {
      "type": "integer",
      "minimum": 0
    }
  },
  "required": [
    "goal_id",
    "job_id"
  ]
}
```

</details>

### `adaptive_goal_knowledge_edge_add`

Append a typed Idea Graph relation with provenance and stable edge identity. recovers_to edges require explicit condition and expected-outcome contracts; recovery relations are excluded from ordinary search by default. This tool never verifies claims or grants execution authority.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `goal_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `from_id` | `string` | Yes | — | minLength: `1`; maxLength: `128` |
| `to_id` | `string` | Yes | — | minLength: `1`; maxLength: `128` |
| `edge_type` | `string` | Yes | — | enum: `supports`, `tested_by`, `enables`, `contradicts`, `alternative_to`, `recovers_to`, `depends_on`, `requires_all` |
| `provenance` | `object` | Yes | — | no additional properties; required fields: `source`, `actor` |
| `condition` | `object` | No | — | no additional properties; required fields: `when`, `predicate` |
| `outcome` | `object` | No | — | no additional properties; required fields: `state`, `effects`, `evidenceRefs` |
| `evidence_refs` | `array` | No | — | maxItems: `64`; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "from_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "to_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "edge_type": {
      "type": "string",
      "enum": [
        "supports",
        "tested_by",
        "enables",
        "contradicts",
        "alternative_to",
        "recovers_to",
        "depends_on",
        "requires_all"
      ]
    },
    "provenance": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "source": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        },
        "actor": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "reference": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        },
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        }
      },
      "required": [
        "source",
        "actor"
      ]
    },
    "condition": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "when": {
          "type": "string",
          "minLength": 1,
          "maxLength": 240
        },
        "predicate": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000
        }
      },
      "required": [
        "when",
        "predicate"
      ]
    },
    "outcome": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "state": {
          "type": "string",
          "minLength": 1,
          "maxLength": 240
        },
        "effects": {
          "type": "array",
          "maxItems": 32,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          }
        },
        "evidenceRefs": {
          "type": "array",
          "maxItems": 64,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2048
          }
        }
      },
      "required": [
        "state",
        "effects",
        "evidenceRefs"
      ]
    },
    "evidence_refs": {
      "type": "array",
      "maxItems": 64,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      }
    }
  },
  "required": [
    "goal_id",
    "from_id",
    "to_id",
    "edge_type",
    "provenance"
  ]
}
```

</details>

### `adaptive_goal_knowledge_search`

Search the shared append-only Idea Graph across goals, including goal/hypothesis/idea/capability/experiment/evidence/condition nodes and cross-goal reuse memberships. This listing does not itself verify claims, current artifact lineage, or independence; use adaptive_goal_knowledge_snapshot_get and adaptive_goal_knowledge_graph_search to check a verifier-signed current snapshot.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `goal_id` | `string` | No | — | minLength: `1`; maxLength: `200` |
| `node_type` | `string` | No | — | enum: `goal`, `hypothesis`, `idea`, `capability`, `experiment`, `evidence`, `condition` |
| `query` | `string` | No | — | minLength: `1`; maxLength: `512` |
| `include_unverified` | `boolean` | No | — | — |
| `include_recovery_edges` | `boolean` | No | — | — |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `500` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "node_type": {
      "type": "string",
      "enum": [
        "goal",
        "hypothesis",
        "idea",
        "capability",
        "experiment",
        "evidence",
        "condition"
      ]
    },
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "include_unverified": {
      "type": "boolean"
    },
    "include_recovery_edges": {
      "type": "boolean"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    }
  }
}
```

</details>

### `adaptive_goal_knowledge_snapshot_get`

Read a complete canonical Goal/Idea Graph snapshot: current node revisions/content/provenance, immutable memberships and their provenance, edges/provenance, source references, integrity issues and exact snapshot hash. Resolves evidence through the live durable artifact/source verifiers and returns an explicit signed-attestation request. Hashes prove integrity, not claim truth; without a trusted verifier signature the graph is not eligible for planning.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `goal_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "goal_id"
  ]
}
```

</details>

### `adaptive_goal_trust_configuration_status`

Read-only for workflow, graph and approval state; records an observed valid trust configuration version/fingerprint in a separate append-only local ledger to prevent downgrade. Reports config version/fingerprint, public-root fingerprints, validity/revocation and administrator change metadata without exposing PEMs. Flags shared provider IDs or roots across source-verifier and reviewer domains. Configure through the host-supported administrator environment mechanism, never through MCP arguments.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

</details>

### `adaptive_goal_knowledge_snapshot_attest`

Persist an externally signed Ed25519 verification for the exact current Goal/Idea Graph snapshot. Requires the configured independent verifier provider/public trust root, current node/revision/edge/membership hashes, and freshly resolved successful producer/result/attempt/completion lineage. Claim truth and evidence independence are accepted only from the trusted signature; payloads from callers cannot self-promote. Uses a transactional append-only ledger with nonce/idempotency checks; never approves or dispatches.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `attestation` | `object` | Yes | — | no additional properties; required fields: `schema_version`, `kind`, `provider_id`, `trust_root_sha256`, `nonce`, `issued_at`, `expires_at`, `scope`, `goal_id`, `snapshot_hash`, `node_ids`, `edge_ids`, `membership_ids`, `evidence_manifest_hash`, `claim_status`, `independence_status`, `signature_algorithm`, `signature` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "attestation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schema_version": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "kind": {
          "type": "string",
          "enum": [
            "adaptive_goal_verified_knowledge_graph_attestation"
          ]
        },
        "provider_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "trust_root_sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "nonce": {
          "type": "string",
          "format": "uuid"
        },
        "issued_at": {
          "type": "string",
          "format": "date-time"
        },
        "expires_at": {
          "type": "string",
          "format": "date-time"
        },
        "scope": {
          "type": "string",
          "enum": [
            "agg.goal_idea_graph.verify"
          ]
        },
        "goal_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "snapshot_hash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "node_ids": {
          "type": "array",
          "uniqueItems": true,
          "maxItems": 500,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "edge_ids": {
          "type": "array",
          "uniqueItems": true,
          "maxItems": 2000,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "membership_ids": {
          "type": "array",
          "uniqueItems": true,
          "maxItems": 10000,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 400
          }
        },
        "evidence_manifest_hash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "claim_status": {
          "type": "string",
          "enum": [
            "verified"
          ]
        },
        "independence_status": {
          "type": "string",
          "enum": [
            "verified"
          ]
        },
        "signature_algorithm": {
          "type": "string",
          "enum": [
            "Ed25519"
          ]
        },
        "signature": {
          "type": "string",
          "minLength": 80,
          "maxLength": 512,
          "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
        }
      },
      "required": [
        "schema_version",
        "kind",
        "provider_id",
        "trust_root_sha256",
        "nonce",
        "issued_at",
        "expires_at",
        "scope",
        "goal_id",
        "snapshot_hash",
        "node_ids",
        "edge_ids",
        "membership_ids",
        "evidence_manifest_hash",
        "claim_status",
        "independence_status",
        "signature_algorithm",
        "signature"
      ]
    }
  },
  "required": [
    "attestation"
  ]
}
```

</details>

### `adaptive_goal_knowledge_graph_search`

Run bounded search using only a freshly revalidated, trusted-attested persisted Goal/Idea Graph, not a caller-supplied graph. Requires the exact snapshot hash and persisted start/goal member IDs. Returns candidates and Plan Graph drafts bound to the current verifier attestation; any changed revision, membership, edge, source bytes, artifact lineage, nonce, signature, or expiry blocks planning.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `goal_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `start_node_id` | `string` | Yes | — | pattern: `^agk-[a-f0-9]{40}$` |
| `goal_node_id` | `string` | Yes | — | pattern: `^agk-[a-f0-9]{40}$` |
| `expected_snapshot_hash` | `string` | Yes | — | pattern: `^[a-f0-9]{64}$` |
| `options` | `object` | No | — | no additional properties |
| `plan_projection_options` | `object` | No | — | no additional properties |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "start_node_id": {
      "type": "string",
      "pattern": "^agk-[a-f0-9]{40}$"
    },
    "goal_node_id": {
      "type": "string",
      "pattern": "^agk-[a-f0-9]{40}$"
    },
    "expected_snapshot_hash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "maxDepth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "beamWidth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "maxExpansions": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10000
        },
        "maxAuditEvents": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5000
        },
        "initiallyAvailableIds": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        }
      }
    },
    "plan_projection_options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "dependencyMode": {
          "type": "string",
          "enum": [
            "sequential_path",
            "source_edges_only"
          ]
        }
      }
    }
  },
  "required": [
    "goal_id",
    "start_node_id",
    "goal_node_id",
    "expected_snapshot_hash"
  ]
}
```

</details>

### `adaptive_goal_knowledge_node_get`

Read the current or a specific immutable Idea Graph node revision, including its stable identity, cross-goal memberships, evidence refs, content hash, provenance hash, and unverified status.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `node_id` | `string` | Yes | — | minLength: `1`; maxLength: `128` |
| `revision` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "node_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "revision": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "node_id"
  ]
}
```

</details>

### `adaptive_goal_knowledge_node_history`

Read append-only revision history for a shared Idea Graph node. Each revision preserves its own canonical content/evidence refs/hash/provenance and remains unverified.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `node_id` | `string` | Yes | — | minLength: `1`; maxLength: `128` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "node_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    }
  },
  "required": [
    "node_id"
  ]
}
```

</details>

### `adaptive_goal_knowledge_recovery_resolve`

Read-only outcome-aware recovery check for a persisted Idea Graph recovers_to edge. Requires explicit matching outcome plus active durable artifact evidence whose hash, producer, result, and completion lineage verifies and whose structured content declares the same outcome. Returns review-only routes; never executes, approves, or dispatches.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `goal_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `source_node_id` | `string` | Yes | — | minLength: `1`; maxLength: `128` |
| `observed_outcome` | `string` | Yes | — | enum: `failed`, `blocked`, `verification_failed`, `evidence_missing`, `contradicted` |
| `evidence_refs` | `array` | Yes | — | minItems: `1`; maxItems: `64`; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "source_node_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "observed_outcome": {
      "type": "string",
      "enum": [
        "failed",
        "blocked",
        "verification_failed",
        "evidence_missing",
        "contradicted"
      ]
    },
    "evidence_refs": {
      "type": "array",
      "minItems": 1,
      "maxItems": 64,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      }
    }
  },
  "required": [
    "goal_id",
    "source_node_id",
    "observed_outcome",
    "evidence_refs"
  ]
}
```

</details>

### `adaptive_goal_plan_compatibility_check`

Read-only compatibility assessment for an unverified AGG Plan Graph draft against a compiled supported workflow template using explicit step-to-task bindings. Reports dependency/template blockers only; never creates a workflow proposal, persists a plan, approves, authorizes, dispatches, or executes.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `draft` | `object` | Yes | — | no additional properties; required fields: `schemaVersion`, `kind`, `status`, `source`, `goal`, `sourcePathNodeIds`, `contextNodes`, `steps`, `gates`, `draftHash` |
| `workflow_id` | `string` | Yes | — | minLength: `1`; maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `task_bindings` | `array` | Yes | — | maxItems: `500`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "draft": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "kind": {
          "type": "string",
          "enum": [
            "adaptive_goal_plan_graph_draft"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "review_required"
          ]
        },
        "source": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "shadow"
              ]
            },
            "graphHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "candidatePlanId": {
              "type": "string",
              "pattern": "^agg-[a-f0-9]{24}$"
            },
            "candidateStatus": {
              "type": "string",
              "enum": [
                "proposed"
              ]
            },
            "verification": {
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "status": {
                      "type": "string",
                      "enum": [
                        "unverified"
                      ]
                    },
                    "verified": {
                      "type": "boolean",
                      "enum": [
                        false
                      ]
                    }
                  },
                  "required": [
                    "status",
                    "verified"
                  ]
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "status": {
                      "type": "string",
                      "enum": [
                        "verified"
                      ]
                    },
                    "verified": {
                      "type": "boolean",
                      "enum": [
                        true
                      ]
                    },
                    "providerId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "attestationId": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "trustRootSha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "snapshotHash": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "evidenceManifestHash": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "issuedAt": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "expiresAt": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "claimVerified": {
                      "type": "boolean",
                      "enum": [
                        true
                      ]
                    },
                    "independenceVerified": {
                      "type": "boolean",
                      "enum": [
                        true
                      ]
                    },
                    "verifiedNodeCount": {
                      "type": "integer",
                      "minimum": 1
                    },
                    "verifiedEdgeCount": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "verifiedMembershipCount": {
                      "type": "integer",
                      "minimum": 1
                    }
                  },
                  "required": [
                    "status",
                    "verified",
                    "providerId",
                    "attestationId",
                    "trustRootSha256",
                    "snapshotHash",
                    "evidenceManifestHash",
                    "issuedAt",
                    "expiresAt",
                    "claimVerified",
                    "independenceVerified",
                    "verifiedNodeCount",
                    "verifiedEdgeCount",
                    "verifiedMembershipCount"
                  ]
                }
              ]
            },
            "searchStatus": {
              "type": "string",
              "enum": [
                "proposals_found",
                "budget_exhausted",
                "max_depth_reached"
              ]
            },
            "searchExhaustive": {
              "type": "boolean"
            }
          },
          "required": [
            "mode",
            "graphHash",
            "candidatePlanId",
            "candidateStatus",
            "verification",
            "searchStatus",
            "searchExhaustive"
          ]
        },
        "goal": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "nodeId": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
              "maxLength": 80
            },
            "label": {
              "type": "string",
              "maxLength": 500
            }
          },
          "required": [
            "nodeId"
          ]
        },
        "sourcePathNodeIds": {
          "type": "array",
          "minItems": 2,
          "maxItems": 500,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          }
        },
        "contextNodes": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "goal",
                  "idea",
                  "hypothesis",
                  "candidate",
                  "capability",
                  "evidence",
                  "condition"
                ]
              },
              "label": {
                "type": "string",
                "maxLength": 500
              },
              "supportingEvidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              },
              "evidenceAssessment": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "status": {
                    "type": "string",
                    "enum": [
                      "missing",
                      "placeholder_only",
                      "declared_unverified"
                    ]
                  },
                  "references": {
                    "type": "array",
                    "maxItems": 64,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "reference": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        },
                        "classification": {
                          "type": "string",
                          "enum": [
                            "placeholder_not_evidence",
                            "content_addressed_source_unverified",
                            "durable_artifact_unverified",
                            "unresolved_reference"
                          ]
                        },
                        "verified": {
                          "type": "boolean",
                          "enum": [
                            false
                          ]
                        }
                      },
                      "required": [
                        "reference",
                        "classification",
                        "verified"
                      ]
                    }
                  },
                  "verifiedReferenceCount": {
                    "type": "integer",
                    "enum": [
                      0
                    ]
                  }
                },
                "required": [
                  "status",
                  "references",
                  "verifiedReferenceCount"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "supportingEvidenceRefs"
            ]
          }
        },
        "steps": {
          "type": "array",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^agg-step-[a-f0-9]{24}$",
                "maxLength": 80
              },
              "sourceNodeId": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "kind": {
                "type": "string",
                "enum": [
                  "task",
                  "experiment"
                ]
              },
              "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": 500
              },
              "dependencies": {
                "type": "array",
                "maxItems": 500,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "pattern": "^agg-step-[a-f0-9]{24}$",
                  "maxLength": 80
                }
              },
              "estimates": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "cost": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1000000000
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "risk": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "successConfidence": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "reusePotential": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "informationValue": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "metricProvenance": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "estimatedCost": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      },
                      "estimatedRisk": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      },
                      "estimatedSuccessConfidence": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      },
                      "reusePotential": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      },
                      "informationValue": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      }
                    },
                    "required": [
                      "estimatedCost",
                      "estimatedRisk",
                      "estimatedSuccessConfidence",
                      "reusePotential",
                      "informationValue"
                    ]
                  }
                },
                "required": [
                  "cost",
                  "risk",
                  "successConfidence"
                ]
              },
              "supportingEvidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              },
              "evidenceAssessment": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "status": {
                    "type": "string",
                    "enum": [
                      "missing",
                      "placeholder_only",
                      "declared_unverified"
                    ]
                  },
                  "references": {
                    "type": "array",
                    "maxItems": 64,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "reference": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        },
                        "classification": {
                          "type": "string",
                          "enum": [
                            "placeholder_not_evidence",
                            "content_addressed_source_unverified",
                            "durable_artifact_unverified",
                            "unresolved_reference"
                          ]
                        },
                        "verified": {
                          "type": "boolean",
                          "enum": [
                            false
                          ]
                        }
                      },
                      "required": [
                        "reference",
                        "classification",
                        "verified"
                      ]
                    }
                  },
                  "verifiedReferenceCount": {
                    "type": "integer",
                    "enum": [
                      0
                    ]
                  }
                },
                "required": [
                  "status",
                  "references",
                  "verifiedReferenceCount"
                ]
              },
              "execution": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "enabled": {
                    "type": "boolean",
                    "enum": [
                      false
                    ]
                  },
                  "authorization": {
                    "type": "string",
                    "enum": [
                      "none"
                    ]
                  },
                  "executable": {
                    "enum": [
                      null
                    ]
                  },
                  "args": {
                    "enum": [
                      null
                    ]
                  }
                },
                "required": [
                  "enabled",
                  "authorization",
                  "executable",
                  "args"
                ]
              },
              "status": {
                "type": "string",
                "enum": [
                  "proposed"
                ]
              }
            },
            "required": [
              "id",
              "sourceNodeId",
              "kind",
              "title",
              "dependencies",
              "estimates",
              "supportingEvidenceRefs",
              "execution",
              "status"
            ]
          }
        },
        "gates": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "humanReviewRequired": {
              "type": "boolean",
              "enum": [
                true
              ]
            },
            "workflowApprovalRequired": {
              "type": "boolean",
              "enum": [
                true
              ]
            },
            "immutableExecutionPlanCreated": {
              "type": "boolean",
              "enum": [
                false
              ]
            },
            "dispatchAllowed": {
              "type": "boolean",
              "enum": [
                false
              ]
            },
            "executionAuthorized": {
              "type": "boolean",
              "enum": [
                false
              ]
            }
          },
          "required": [
            "humanReviewRequired",
            "workflowApprovalRequired",
            "immutableExecutionPlanCreated",
            "dispatchAllowed",
            "executionAuthorized"
          ]
        },
        "draftHash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "schemaVersion",
        "kind",
        "status",
        "source",
        "goal",
        "sourcePathNodeIds",
        "contextNodes",
        "steps",
        "gates",
        "draftHash"
      ]
    },
    "workflow_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80,
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
    },
    "task_bindings": {
      "type": "array",
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "step_id": {
            "type": "string",
            "pattern": "^agg-step-[a-f0-9]{24}$",
            "maxLength": 80
          },
          "task_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        },
        "required": [
          "step_id",
          "task_id"
        ]
      }
    }
  },
  "required": [
    "draft",
    "workflow_id",
    "task_bindings"
  ]
}
```

</details>

### `adaptive_goal_plan_proposal_create`

Create a review-only Plan Graph proposal from a freshly revalidated candidate using explicit step-to-task bindings. Legacy graph arguments remain caller-supplied shadow inputs and cannot authorize downstream Execution Graph creation. Verified mode omits graph and supplies knowledge_goal_id/start/goal node IDs plus exact knowledge_snapshot_hash; the runtime rebuilds the graph from its append-only store, verifies the current external attestation and durable evidence lineage, and binds its attestation/snapshot hashes into the draft, fingerprint and durable proposal. Creates a PROPOSED review wrapper only; human approval still does not grant AGG action authority.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `graph` | `object` | No | — | no additional properties; required fields: `schemaVersion`, `startNodeId`, `goalNodeId`, `nodes`, `edges` |
| `knowledge_goal_id` | `string` | No | — | minLength: `1`; maxLength: `200` |
| `knowledge_start_node_id` | `string` | No | — | pattern: `^agk-[a-f0-9]{40}$` |
| `knowledge_goal_node_id` | `string` | No | — | pattern: `^agk-[a-f0-9]{40}$` |
| `knowledge_snapshot_hash` | `string` | No | — | pattern: `^[a-f0-9]{64}$` |
| `candidate_plan_id` | `string` | Yes | — | maxLength: `80`; pattern: `^agg-[a-f0-9]{24}$` |
| `options` | `object` | No | — | no additional properties |
| `plan_projection_options` | `object` | No | — | no additional properties |
| `workflow_id` | `string` | Yes | — | enum: `standard-engineering`, `hybrid-engineering`, `engineering`, `production` |
| `task_bindings` | `array` | Yes | — | maxItems: `500`; items: object |
| `workspace` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `title` | `string` | No | — | minLength: `1`; maxLength: `140` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "graph": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "startNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "goalNodeId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80,
          "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
        },
        "nodes": {
          "type": "array",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "goal",
                  "idea",
                  "hypothesis",
                  "candidate",
                  "experiment",
                  "capability",
                  "evidence",
                  "condition",
                  "task"
                ]
              },
              "label": {
                "type": "string",
                "maxLength": 500
              },
              "estimatedCost": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1000000000
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedRisk": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "estimatedSuccessConfidence": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "reusePotential": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "informationValue": {
                "oneOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  {
                    "enum": [
                      null
                    ]
                  }
                ]
              },
              "metricProvenance": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "estimatedCost": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedRisk": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "estimatedSuccessConfidence": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "reusePotential": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  },
                  "informationValue": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "method": {
                        "type": "string",
                        "maxLength": 240
                      },
                      "sourceRefs": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        }
                      },
                      "confidence": {
                        "oneOf": [
                          {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1
                          },
                          {
                            "enum": [
                              null
                            ]
                          }
                        ]
                      }
                    }
                  }
                }
              },
              "evidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              }
            },
            "required": [
              "id",
              "type"
            ]
          }
        },
        "edges": {
          "type": "array",
          "maxItems": 2000,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "from": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "to": {
                "type": "string",
                "minLength": 1,
                "maxLength": 80,
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "type": {
                "type": "string",
                "enum": [
                  "next_step",
                  "requires_all",
                  "depends_on",
                  "supports",
                  "alternative_to",
                  "enables",
                  "tested_by",
                  "contradicts",
                  "recovers_to"
                ]
              },
              "condition": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "onOutcome": {
                    "type": "string",
                    "enum": [
                      "failed",
                      "blocked",
                      "verification_failed",
                      "evidence_missing",
                      "contradicted"
                    ]
                  },
                  "requiresEvidenceNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  },
                  "requiresAllNodeIds": {
                    "type": "array",
                    "maxItems": 500,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
                    }
                  }
                },
                "required": [
                  "onOutcome",
                  "requiresEvidenceNodeIds",
                  "requiresAllNodeIds"
                ]
              }
            },
            "required": [
              "from",
              "to",
              "type"
            ]
          }
        }
      },
      "required": [
        "schemaVersion",
        "startNodeId",
        "goalNodeId",
        "nodes",
        "edges"
      ]
    },
    "knowledge_goal_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "knowledge_start_node_id": {
      "type": "string",
      "pattern": "^agk-[a-f0-9]{40}$"
    },
    "knowledge_goal_node_id": {
      "type": "string",
      "pattern": "^agk-[a-f0-9]{40}$"
    },
    "knowledge_snapshot_hash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "candidate_plan_id": {
      "type": "string",
      "pattern": "^agg-[a-f0-9]{24}$",
      "maxLength": 80
    },
    "options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "maxDepth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "beamWidth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "maxExpansions": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10000
        },
        "maxAuditEvents": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5000
        },
        "initiallyAvailableIds": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        }
      }
    },
    "plan_projection_options": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "dependencyMode": {
          "type": "string",
          "enum": [
            "sequential_path",
            "source_edges_only"
          ]
        }
      }
    },
    "workflow_id": {
      "type": "string",
      "enum": [
        "standard-engineering",
        "hybrid-engineering",
        "engineering",
        "production"
      ]
    },
    "task_bindings": {
      "type": "array",
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "step_id": {
            "type": "string",
            "pattern": "^agg-step-[a-f0-9]{24}$",
            "maxLength": 80
          },
          "task_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          }
        },
        "required": [
          "step_id",
          "task_id"
        ]
      }
    },
    "workspace": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 140
    }
  },
  "oneOf": [
    {
      "required": [
        "graph"
      ]
    },
    {
      "required": [
        "knowledge_goal_id",
        "knowledge_start_node_id",
        "knowledge_goal_node_id",
        "knowledge_snapshot_hash"
      ]
    }
  ],
  "required": [
    "candidate_plan_id",
    "workflow_id",
    "task_bindings"
  ]
}
```

</details>

### `adaptive_goal_plan_proposal_get`

Read back and revalidate the exact AGG proposal snapshot (source graph, candidate-derived Plan Graph draft, draft/mapping hashes, and structural template compatibility). Read-only; it does not alter workflow state, approve, dispatch, or execute.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "job_id"
  ]
}
```

</details>

### `adaptive_goal_execution_readiness_check`

Read-only assessment of explicit AGG action-to-task mappings against immutable role capability/input/output artifact contracts, compiled dependency ancestry, and durable artifact/evidence lineage. It distinguishes contract readiness from source-evidence readiness and never creates an Execution Graph or executable contract, grants permissions, approves, dispatches, or executes.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `draft` | `object` | Yes | — | no additional properties; required fields: `schemaVersion`, `kind`, `status`, `source`, `goal`, `sourcePathNodeIds`, `contextNodes`, `steps`, `gates`, `draftHash` |
| `workflow_id` | `string` | Yes | — | enum: `standard-engineering`, `hybrid-engineering`, `engineering`, `production` |
| `task_bindings` | `array` | Yes | — | maxItems: `500`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "draft": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "enum": [
            1
          ]
        },
        "kind": {
          "type": "string",
          "enum": [
            "adaptive_goal_plan_graph_draft"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "review_required"
          ]
        },
        "source": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "mode": {
              "type": "string",
              "enum": [
                "shadow"
              ]
            },
            "graphHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "candidatePlanId": {
              "type": "string",
              "pattern": "^agg-[a-f0-9]{24}$"
            },
            "candidateStatus": {
              "type": "string",
              "enum": [
                "proposed"
              ]
            },
            "verification": {
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "status": {
                      "type": "string",
                      "enum": [
                        "unverified"
                      ]
                    },
                    "verified": {
                      "type": "boolean",
                      "enum": [
                        false
                      ]
                    }
                  },
                  "required": [
                    "status",
                    "verified"
                  ]
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "status": {
                      "type": "string",
                      "enum": [
                        "verified"
                      ]
                    },
                    "verified": {
                      "type": "boolean",
                      "enum": [
                        true
                      ]
                    },
                    "providerId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "attestationId": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "trustRootSha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "snapshotHash": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "evidenceManifestHash": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "issuedAt": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "expiresAt": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "claimVerified": {
                      "type": "boolean",
                      "enum": [
                        true
                      ]
                    },
                    "independenceVerified": {
                      "type": "boolean",
                      "enum": [
                        true
                      ]
                    },
                    "verifiedNodeCount": {
                      "type": "integer",
                      "minimum": 1
                    },
                    "verifiedEdgeCount": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "verifiedMembershipCount": {
                      "type": "integer",
                      "minimum": 1
                    }
                  },
                  "required": [
                    "status",
                    "verified",
                    "providerId",
                    "attestationId",
                    "trustRootSha256",
                    "snapshotHash",
                    "evidenceManifestHash",
                    "issuedAt",
                    "expiresAt",
                    "claimVerified",
                    "independenceVerified",
                    "verifiedNodeCount",
                    "verifiedEdgeCount",
                    "verifiedMembershipCount"
                  ]
                }
              ]
            },
            "searchStatus": {
              "type": "string",
              "enum": [
                "proposals_found",
                "budget_exhausted",
                "max_depth_reached"
              ]
            },
            "searchExhaustive": {
              "type": "boolean"
            }
          },
          "required": [
            "mode",
            "graphHash",
            "candidatePlanId",
            "candidateStatus",
            "verification",
            "searchStatus",
            "searchExhaustive"
          ]
        },
        "goal": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "nodeId": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
              "maxLength": 80
            },
            "label": {
              "type": "string",
              "maxLength": 500
            }
          },
          "required": [
            "nodeId"
          ]
        },
        "sourcePathNodeIds": {
          "type": "array",
          "minItems": 2,
          "maxItems": 500,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          }
        },
        "contextNodes": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "goal",
                  "idea",
                  "hypothesis",
                  "candidate",
                  "capability",
                  "evidence",
                  "condition"
                ]
              },
              "label": {
                "type": "string",
                "maxLength": 500
              },
              "supportingEvidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              },
              "evidenceAssessment": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "status": {
                    "type": "string",
                    "enum": [
                      "missing",
                      "placeholder_only",
                      "declared_unverified"
                    ]
                  },
                  "references": {
                    "type": "array",
                    "maxItems": 64,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "reference": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        },
                        "classification": {
                          "type": "string",
                          "enum": [
                            "placeholder_not_evidence",
                            "content_addressed_source_unverified",
                            "durable_artifact_unverified",
                            "unresolved_reference"
                          ]
                        },
                        "verified": {
                          "type": "boolean",
                          "enum": [
                            false
                          ]
                        }
                      },
                      "required": [
                        "reference",
                        "classification",
                        "verified"
                      ]
                    }
                  },
                  "verifiedReferenceCount": {
                    "type": "integer",
                    "enum": [
                      0
                    ]
                  }
                },
                "required": [
                  "status",
                  "references",
                  "verifiedReferenceCount"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "supportingEvidenceRefs"
            ]
          }
        },
        "steps": {
          "type": "array",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^agg-step-[a-f0-9]{24}$",
                "maxLength": 80
              },
              "sourceNodeId": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "kind": {
                "type": "string",
                "enum": [
                  "task",
                  "experiment"
                ]
              },
              "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": 500
              },
              "dependencies": {
                "type": "array",
                "maxItems": 500,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "pattern": "^agg-step-[a-f0-9]{24}$",
                  "maxLength": 80
                }
              },
              "estimates": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "cost": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1000000000
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "risk": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "successConfidence": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "reusePotential": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "informationValue": {
                    "oneOf": [
                      {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      {
                        "enum": [
                          null
                        ]
                      }
                    ]
                  },
                  "metricProvenance": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "estimatedCost": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      },
                      "estimatedRisk": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      },
                      "estimatedSuccessConfidence": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      },
                      "reusePotential": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      },
                      "informationValue": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "classification": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "caller_estimate_unverified"
                            ]
                          },
                          "method": {
                            "oneOf": [
                              {
                                "type": "string",
                                "maxLength": 240
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "sourceRefs": {
                            "type": "array",
                            "maxItems": 16,
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            }
                          },
                          "confidence": {
                            "oneOf": [
                              {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              {
                                "enum": [
                                  null
                                ]
                              }
                            ]
                          },
                          "provenanceVerified": {
                            "type": "boolean",
                            "enum": [
                              false
                            ]
                          }
                        },
                        "required": [
                          "classification",
                          "method",
                          "sourceRefs",
                          "confidence",
                          "provenanceVerified"
                        ]
                      }
                    },
                    "required": [
                      "estimatedCost",
                      "estimatedRisk",
                      "estimatedSuccessConfidence",
                      "reusePotential",
                      "informationValue"
                    ]
                  }
                },
                "required": [
                  "cost",
                  "risk",
                  "successConfidence"
                ]
              },
              "supportingEvidenceRefs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 512
                }
              },
              "evidenceAssessment": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "status": {
                    "type": "string",
                    "enum": [
                      "missing",
                      "placeholder_only",
                      "declared_unverified"
                    ]
                  },
                  "references": {
                    "type": "array",
                    "maxItems": 64,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "reference": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 512
                        },
                        "classification": {
                          "type": "string",
                          "enum": [
                            "placeholder_not_evidence",
                            "content_addressed_source_unverified",
                            "durable_artifact_unverified",
                            "unresolved_reference"
                          ]
                        },
                        "verified": {
                          "type": "boolean",
                          "enum": [
                            false
                          ]
                        }
                      },
                      "required": [
                        "reference",
                        "classification",
                        "verified"
                      ]
                    }
                  },
                  "verifiedReferenceCount": {
                    "type": "integer",
                    "enum": [
                      0
                    ]
                  }
                },
                "required": [
                  "status",
                  "references",
                  "verifiedReferenceCount"
                ]
              },
              "execution": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "enabled": {
                    "type": "boolean",
                    "enum": [
                      false
                    ]
                  },
                  "authorization": {
                    "type": "string",
                    "enum": [
                      "none"
                    ]
                  },
                  "executable": {
                    "enum": [
                      null
                    ]
                  },
                  "args": {
                    "enum": [
                      null
                    ]
                  }
                },
                "required": [
                  "enabled",
                  "authorization",
                  "executable",
                  "args"
                ]
              },
              "status": {
                "type": "string",
                "enum": [
                  "proposed"
                ]
              }
            },
            "required": [
              "id",
              "sourceNodeId",
              "kind",
              "title",
              "dependencies",
              "estimates",
              "supportingEvidenceRefs",
              "execution",
              "status"
            ]
          }
        },
        "gates": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "humanReviewRequired": {
              "type": "boolean",
              "enum": [
                true
              ]
            },
            "workflowApprovalRequired": {
              "type": "boolean",
              "enum": [
                true
              ]
            },
            "immutableExecutionPlanCreated": {
              "type": "boolean",
              "enum": [
                false
              ]
            },
            "dispatchAllowed": {
              "type": "boolean",
              "enum": [
                false
              ]
            },
            "executionAuthorized": {
              "type": "boolean",
              "enum": [
                false
              ]
            }
          },
          "required": [
            "humanReviewRequired",
            "workflowApprovalRequired",
            "immutableExecutionPlanCreated",
            "dispatchAllowed",
            "executionAuthorized"
          ]
        },
        "draftHash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "schemaVersion",
        "kind",
        "status",
        "source",
        "goal",
        "sourcePathNodeIds",
        "contextNodes",
        "steps",
        "gates",
        "draftHash"
      ]
    },
    "workflow_id": {
      "type": "string",
      "enum": [
        "standard-engineering",
        "hybrid-engineering",
        "engineering",
        "production"
      ]
    },
    "task_bindings": {
      "type": "array",
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "step_id": {
            "type": "string",
            "pattern": "^agg-step-[a-f0-9]{24}$",
            "maxLength": 80
          },
          "task_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          },
          "capability": {
            "type": "string",
            "enum": [
              "product.requirements",
              "research.collect",
              "architecture.design",
              "code.modify",
              "security.audit",
              "code.verify",
              "infrastructure.verify",
              "documentation.write",
              "change.review",
              "synthesis.approve"
            ]
          }
        },
        "required": [
          "step_id",
          "task_id",
          "capability"
        ]
      }
    }
  },
  "required": [
    "draft",
    "workflow_id",
    "task_bindings"
  ]
}
```

</details>

### `adaptive_goal_execution_graph_proposal_create`

Create a persisted, review-only Execution Graph proposal from a stored Plan Graph proposal after revalidating its candidate, exact draft/bindings, role/capability contracts, DAG ancestry, active durable artifact/event lineage, producer completion, schema versions and hashes. Requires readiness to pass; otherwise returns stable blockers without writing a job. A successful result creates only a PROPOSED standard-engineering review wrapper, never executable contracts, task rows, approval, dispatch or execution.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `plan_proposal_job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `task_bindings` | `array` | Yes | — | maxItems: `500`; items: object |
| `title` | `string` | No | — | minLength: `1`; maxLength: `180` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "plan_proposal_job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "task_bindings": {
      "type": "array",
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "step_id": {
            "type": "string",
            "pattern": "^agg-step-[a-f0-9]{24}$",
            "maxLength": 80
          },
          "task_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
          },
          "capability": {
            "type": "string",
            "enum": [
              "product.requirements",
              "research.collect",
              "architecture.design",
              "code.modify",
              "security.audit",
              "code.verify",
              "infrastructure.verify",
              "documentation.write",
              "change.review",
              "synthesis.approve"
            ]
          }
        },
        "required": [
          "step_id",
          "task_id",
          "capability"
        ]
      }
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 180
    }
  },
  "required": [
    "plan_proposal_job_id",
    "task_bindings"
  ]
}
```

</details>

### `adaptive_goal_execution_graph_proposal_get`

Read back and revalidate a stored Execution Graph proposal against its source Plan Graph proposal and current durable artifact evidence. Reports stale hashes, changed workflow contracts or invalidated evidence as stable blockers. Read-only; never pins plans, approves, dispatches or executes.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "job_id"
  ]
}
```

</details>

### `adaptive_goal_execution_plan_candidate_create`

Validate and persist a review-only execution-plan candidate using the existing workflow compiler, validateExecutionPlan and exact preflight plan hash. The versioned semantic policy checks each role capability, canonical operation, target binding, artifact output type, exact role completion criteria and canonical description; arbitrary/free-form instructions and unresolved targets are rejected. Reviewer identity is not inferred from caller-supplied reviewerId: the candidate remains blocked until a trusted Ed25519 identity provider attestation is durably recorded and verified against the configured public trust root and exact candidate/semantic/role-contract/immutable-plan fingerprints. Candidate creation writes only a bounded candidate event; it never approves, pins workflow_plans, creates tasks, dispatches, grants execution authorization or generates commands/arguments.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `reviewed_action_intents` | `object` | Yes | — | no additional properties; required fields: `schemaVersion`, `kind`, `source`, `review`, `actions` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "reviewed_action_intents": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "const": 1
        },
        "kind": {
          "type": "string",
          "const": "adaptive_goal_reviewed_action_intents"
        },
        "source": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "executionGraphFingerprint": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "executionGraphProposalHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "sourcePlanProposalJobId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "sourceGraphHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "planGraphDraftHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "sourceCandidateId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            }
          },
          "required": [
            "executionGraphFingerprint",
            "executionGraphProposalHash",
            "sourcePlanProposalJobId",
            "sourceGraphHash",
            "planGraphDraftHash",
            "sourceCandidateId"
          ]
        },
        "review": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "decision": {
              "type": "string",
              "const": "reviewed_for_candidate_only"
            },
            "reviewerId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._@:-]*$"
            },
            "reviewedAt": {
              "type": "string",
              "format": "date-time",
              "maxLength": 32
            },
            "acknowledgment": {
              "type": "string",
              "const": "I_REVIEWED_ACTION_INTENTS_AND_INPUT_BINDINGS_FOR_CANDIDATE_REVIEW_ONLY"
            }
          },
          "required": [
            "decision",
            "reviewerId",
            "reviewedAt",
            "acknowledgment"
          ]
        },
        "actions": {
          "type": "array",
          "minItems": 1,
          "maxItems": 256,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "stepId": {
                "type": "string",
                "pattern": "^agg-step-[a-f0-9]{24}$"
              },
              "taskId": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
              },
              "role": {
                "type": "string",
                "enum": [
                  "product-owner",
                  "researcher",
                  "architect",
                  "engineer",
                  "security",
                  "qa",
                  "platform",
                  "writer",
                  "reviewer",
                  "cto"
                ]
              },
              "capability": {
                "type": "string",
                "enum": [
                  "product.requirements",
                  "research.collect",
                  "architecture.design",
                  "code.modify",
                  "security.audit",
                  "code.verify",
                  "infrastructure.verify",
                  "documentation.write",
                  "change.review",
                  "synthesis.approve"
                ]
              },
              "roleContractId": {
                "type": "string",
                "enum": [
                  "agent.product-owner",
                  "agent.researcher",
                  "agent.architect",
                  "agent.engineer",
                  "agent.security",
                  "agent.qa",
                  "agent.platform",
                  "agent.writer",
                  "agent.reviewer",
                  "agent.cto"
                ]
              },
              "roleContractVersion": {
                "type": "integer",
                "minimum": 1
              },
              "actionIntent": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "operation": {
                    "type": "string",
                    "enum": [
                      "analyze",
                      "design",
                      "document",
                      "implement",
                      "investigate",
                      "prepare",
                      "review",
                      "verify",
                      "other"
                    ]
                  },
                  "target": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "kind": {
                        "type": "string",
                        "enum": [
                          "artifact",
                          "codebase",
                          "component",
                          "requirement",
                          "work_item",
                          "other"
                        ]
                      },
                      "reference": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
                      }
                    },
                    "required": [
                      "kind",
                      "reference"
                    ]
                  },
                  "description": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1200
                  },
                  "successCriteria": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 12,
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 300
                    }
                  }
                },
                "required": [
                  "operation",
                  "target",
                  "description",
                  "successCriteria"
                ]
              },
              "taskInputs": {
                "type": "array",
                "maxItems": 64,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "inputType": {
                      "type": "string",
                      "enum": [
                        "requirements",
                        "research",
                        "architecture",
                        "implementation",
                        "security-review",
                        "qa-report",
                        "platform-review",
                        "documentation",
                        "review"
                      ]
                    },
                    "source": {
                      "oneOf": [
                        {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "evidence"
                            },
                            "reference": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 1024
                            }
                          },
                          "required": [
                            "kind",
                            "reference"
                          ]
                        },
                        {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "ancestor_output"
                            },
                            "stepId": {
                              "type": "string",
                              "pattern": "^agg-step-[a-f0-9]{24}$"
                            }
                          },
                          "required": [
                            "kind",
                            "stepId"
                          ]
                        }
                      ]
                    }
                  },
                  "required": [
                    "inputType",
                    "source"
                  ]
                }
              },
              "dependencyStepIds": {
                "type": "array",
                "maxItems": 256,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "pattern": "^agg-step-[a-f0-9]{24}$"
                }
              },
              "evidenceRefs": {
                "type": "array",
                "maxItems": 512,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1024
                }
              }
            },
            "required": [
              "stepId",
              "taskId",
              "role",
              "capability",
              "roleContractId",
              "roleContractVersion",
              "actionIntent",
              "taskInputs",
              "dependencyStepIds",
              "evidenceRefs"
            ]
          }
        }
      },
      "required": [
        "schemaVersion",
        "kind",
        "source",
        "review",
        "actions"
      ]
    }
  },
  "required": [
    "job_id",
    "reviewed_action_intents"
  ]
}
```

</details>

### `adaptive_goal_execution_plan_candidate_get`

Read-only rebuild and revalidation of the persisted review-only candidate, exact action-intent semantics, typed input/evidence/ancestor provenance, role/artifact contracts, current source evidence, compiler and plan hashes. Reports tampering/staleness and trust-root-verified reviewer status. Without a valid, unexpired, replay-free identity-provider attestation bound to the exact candidate and immutable-plan fingerprints, the reviewer identity blocker remains and approval/dispatch/task preparation are denied. This tool does not refresh snapshots, approve, pin plans, create tasks or dispatch.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "job_id"
  ]
}
```

</details>

### `adaptive_goal_sandbox_action_execute`

Experimental/test-only executor for one hard-coded, no-network fixture action. Requires a current trust-root-verified reviewer attestation, explicit workflow approval, exact immutable compiler plan, dispatched active workflow, completed task prerequisites, and current typed artifact/result/completion lineage. Executes no caller-supplied command, script, or path. Refuses production mode, missing/tampered evidence, unsupported action, unresolved prior claims, and replay; repeated requests can only read the exact already-verified receipt without re-executing. This tool never grants approval or production execution authority.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `task_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "task_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "job_id",
    "task_id"
  ]
}
```

</details>

### `workflow_catalog`

Read-only discovery of supported local workflow templates, exact workflow IDs/versions and intended execution modes. Use first when choosing a template; then workflow_create and workflow_preflight. This does not create, approve, or run a workflow.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

</details>

### `workflow_recommend_resources`

Proactive, read-only discovery for a task goal. Use before creating a substantial workflow even when the user did not name roles, policies, skills, or reusable workflows. Ranks saved custom workflows, custom roles/attached skills, saved policies, and built-in role hints using deterministic Vietnamese/English lexical matching. Prefer compatible high-confidence existing resources over near-duplicates, but inspect contracts and policy scope; lexical scores are hints, not semantic proof. Does not attach policies, bind roles, mutate storage, approve, or execute.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `task` | `string` | Yes | — | minLength: `1`; maxLength: `12000` |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `10`; default: `5` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "task": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10,
      "default": 5
    }
  },
  "required": [
    "task"
  ]
}
```

</details>

### `workflow_policy_catalog`

Read-only discovery of policy predicate types and their real runtime enforcement points. Use before drafting a policy; do not invent predicates or treat a catalog entry as proof a policy is attached/enforced for a particular run.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

</details>

### `workflow_policy_create`

State-changing: create immutable version 1 of a reusable workflow policy pack after reviewing workflow_policy_catalog. Use only the closed predicate schema; no executable code/arbitrary expressions are accepted. Validate before attaching; creation alone does not attach the policy to a workflow.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | maxLength: `2000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "policy_id",
    "name"
  ]
}
```

</details>

### `workflow_policy_list`

Read-only list/search of saved policy packs. Set include_versions when comparing immutable revisions; use workflow_policy_get for a specific pack. This does not validate or attach a policy.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `include_versions` | `boolean` | No | — | — |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `200` |
| `query` | `string` | No | — | maxLength: `120` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "include_versions": {
      "type": "boolean"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    },
    "query": {
      "type": "string",
      "maxLength": 120
    }
  }
}
```

</details>

### `workflow_policy_get`

Read-only inspection of a policy pack's latest or exact immutable version and workflows that pin it. Use to verify the intended revision/attachments before changes; it does not attach or update anything.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "policy_id"
  ]
}
```

</details>

### `workflow_policy_update`

State-changing: create the next immutable version of an existing policy pack. Omitted fields are retained; old versions and plans already pinned to them do not change. Validate the new version and explicitly attach an exact version to an eligible unapproved proposal if needed.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | No | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | maxLength: `2000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "policy_id"
  ]
}
```

</details>

### `workflow_policy_validate`

Read-only validation of a proposed policy pack without storing it. Checks closed schema, rule conflicts and policy-level invariants; target-plan compatibility is checked again when attaching. Use before create/update/attach; a valid policy is not yet attached or enforced.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | maxLength: `2000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "policy_id",
    "name"
  ]
}
```

</details>

### `workflow_policy_attach`

State-changing: attach an exact policy version only to an active, unapproved workflow proposal. The snapshot is pinned into the later plan hash; attachment is prohibited after approval/compilation. Use after policy validation and before workflow_approve; create a new proposal if the plan is already approved.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "job_id",
    "policy_id"
  ]
}
```

</details>

### `workflow_create`

Create a proposal only. Optional role_bindings pin immutable role-profile snapshots. For workspace edits, declare required_operations:["workspace.write"] plus explicit role-specific relative scopes (only built-in engineer/writer on standard-engineering v3+); scopes grant neither shell access nor unscoped filesystem access. Next call workflow_preflight, inspect the immutable plan/readiness, then obtain explicit human approval. Creation never approves or executes.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `title` | `string` | Yes | — | minLength: `1`; maxLength: `180` |
| `task` | `string` | Yes | — | minLength: `1`; maxLength: `12000` |
| `workflow` | `string` | No | — | enum: `standard-engineering`, `hybrid-engineering`, `engineering`, `production`; default: `"standard-engineering"` |
| `workspace` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `validation_profile` | `object` | No | — | no additional properties; required fields: `profile_id`, `profile_version` |
| `role_bindings` | `array` | No | — | maxItems: `9`; items: object |
| `required_operations` | `array` | No | — | maxItems: `4`; unique items; items: string |
| `workspace_write_scopes` | `array` | No | — | maxItems: `8`; items: object |
| `goal` | `string` | No | — | minLength: `1`; maxLength: `4000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 180
    },
    "task": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "workflow": {
      "type": "string",
      "enum": [
        "standard-engineering",
        "hybrid-engineering",
        "engineering",
        "production"
      ],
      "default": "standard-engineering"
    },
    "workspace": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "validation_profile": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "profile_id": {
          "type": "string",
          "enum": [
            "core-release-validation",
            "plugin-e2e",
            "mcpb-package-build",
            "mcpb-package-build-isolated",
            "mcpb-workspace-smoke"
          ]
        },
        "profile_version": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "profile_id",
        "profile_version"
      ]
    },
    "role_bindings": {
      "type": "array",
      "maxItems": 9,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "role": {
            "type": "string",
            "enum": [
              "product-owner",
              "researcher",
              "architect",
              "engineer",
              "security",
              "qa",
              "platform",
              "writer",
              "reviewer"
            ]
          },
          "custom_role_id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "custom_role_version": {
            "type": "integer",
            "minimum": 1
          }
        },
        "required": [
          "role",
          "custom_role_id",
          "custom_role_version"
        ]
      }
    },
    "required_operations": {
      "type": "array",
      "maxItems": 4,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "enum": [
          "workspace.write"
        ]
      }
    },
    "workspace_write_scopes": {
      "type": "array",
      "maxItems": 8,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "role": {
            "type": "string",
            "enum": [
              "engineer",
              "writer"
            ]
          },
          "paths": {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 500
                },
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "directory"
                  ]
                }
              },
              "required": [
                "path",
                "kind"
              ]
            }
          }
        },
        "required": [
          "role",
          "paths"
        ]
      }
    },
    "goal": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "title",
    "task"
  ]
}
```

</details>

### `workflow_list`

Read-only list of locally stored active workflows. Use to find a job_id when it is not known, then inspect that run with workflow_get; this does not advance or mutate any workflow.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `limit` | `integer` | No | — | minimum: `1`; maximum: `100` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    }
  },
  "additionalProperties": false
}
```

</details>

### `workflow_get`

Read-only inspection of local workflow state, immutable plan/hash, task states, artifact metadata and phase. Use before approval or when diagnosing a specific job; it does not expose full result bodies or mutate state.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_liveness_diagnostics`

Read-only diagnosis of active-job liveness using durable job/task/event timestamps and task-lease heartbeats/expiry. Reports stale candidates and safe inspection hints; old activity is not proof a worker is dead. Never changes job/task state, expires or reacquires leases, retries, dispatches, or grants permission.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | No | — | minLength: `1`; maxLength: `200` |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `100`; default: `25` |
| `stale_after_ms` | `integer` | No | — | minimum: `60000`; maximum: `604800000`; default: `900000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 25
    },
    "stale_after_ms": {
      "type": "integer",
      "minimum": 60000,
      "maximum": 604800000,
      "default": 900000
    }
  }
}
```

</details>

### `workflow_preflight`

Read-only feasibility check of a proposal or approved immutable plan. Compiles in memory without creating/changing a plan, checks workflow/version compatibility, role capability/permission contracts, scoped workspace-write roots, and plan/hash consistency. Run before workflow_approve; approval independently repeats the gate. A ready result is not approval or execution.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "job_id"
  ]
}
```

</details>

### `workflow_approve`

State-changing approval: use only after workflow_preflight is ready, the proposal and proposed immutable plan are inspected, and explicit human approval is obtained. Re-runs feasibility checks, then pins the plan; do not edit it in place afterward. Approval is not dispatch—call workflow_dispatch next.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |
| `confirmation` | `string` | Yes | — | minLength: `3`; maxLength: `2000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    },
    "confirmation": {
      "type": "string",
      "minLength": 3,
      "maxLength": 2000
    }
  },
  "required": [
    "job_id",
    "confirmation"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_dispatch`

State-changing dispatch: use only for a proposal already approved with a current immutable plan. Starts the local workflow and creates its durable coordinator task; no cloud/remote worker is contacted. Then prepare tasks or use workflow_coordinator_step to advance.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_prepare_tasks`

State-changing task preparation/recovery: use after workflow_dispatch when the immutable plan's child tasks need creating or reconciling. Safe to repeat for the same approved plan; does not execute tasks. Next call workflow_next_task or workflow_coordinator_step.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_next_task`

Use after task preparation and after each recorded completion to obtain the next dependency-ready task, exact role contract and predecessor evidence. Deterministic tasks must use the approved task_execute_local/execute_batch path; specialist reasoning tasks use workflow_complete_task. If no task is ready or a gate blocks progress, inspect/diagnose rather than inventing a result.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_diagnose`

Read-only diagnosis when a local workflow is blocked, stuck, failed, or unexpectedly pending. Correlates task states, reviewer findings, stale/missing artifacts and safe next actions; it never mutates state. Use diagnosis before authorized rework/reviewer revision and never treat it as a repair or gate bypass.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "job_id"
  ]
}
```

</details>

### `workflow_request_rework`

State-changing review recovery, supported only when the exact immutable plan has workflow_id=standard-engineering and workflow_version>=2, and the job is active/EXECUTING with current approval. engineering@2 is not compatible. Use workflow_diagnose first; unsupported plans need a new proposal and approval, not retries. Rework preserves the immutable plan and approval gates and does not complete work.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `reason` | `string` | Yes | — | minLength: `1`; maxLength: `4000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    }
  },
  "required": [
    "job_id",
    "reason"
  ]
}
```

</details>

### `workflow_request_reviewer_revision`

Narrow review recovery, supported only for workflow_id=standard-engineering and version>=2 in an active/EXECUTING job with current approval; use only for an accepted review blocked solely by evidenceIssues when all other acceptance flags/findings pass. engineering@2 is not compatible. Does not approve synthesis or weaken the contract.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `reason` | `string` | Yes | — | minLength: `1`; maxLength: `4000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    }
  },
  "required": [
    "job_id",
    "reason"
  ]
}
```

</details>

### `workflow_complete_task`

State-changing completion for a currently issued, dependency-ready non-deterministic local specialist task. Persist the actual result and typed artifact; record outcome=failed when work failed. Do not fabricate results or use this for deterministic tasks, which require task_execute_local/execute_batch. Request the next task after completion.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `task_id` | `string` | Yes | — | minLength: `1` |
| `content` | `string` | Yes | — | minLength: `1`; maxLength: `1000000` |
| `artifact` | `object` | Yes | — | — |
| `outcome` | `string` | No | — | enum: `success`, `failed`; default: `"success"` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "minLength": 1
    },
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1000000
    },
    "artifact": {
      "type": "object"
    },
    "outcome": {
      "type": "string",
      "enum": [
        "success",
        "failed"
      ],
      "default": "success"
    }
  },
  "required": [
    "task_id",
    "content",
    "artifact"
  ],
  "additionalProperties": false
}
```

</details>

### `task_execute_local`

State-changing local execution for one prepared deterministic task whose executable, arguments and workspace are fixed by the approved immutable plan. Do not use this route for any task whose immutable batch policy requires execute_batch, even for a single-item batch. No arbitrary commands or remote execution are accepted. Inspect the actual exit/output and then request the next task.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `task_id` | `string` | Yes | — | minLength: `1` |
| `timeout_ms` | `integer` | No | — | minimum: `1000`; maximum: `600000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "task_id": {
      "type": "string",
      "minLength": 1
    },
    "timeout_ms": {
      "type": "integer",
      "minimum": 1000,
      "maximum": 600000
    }
  },
  "required": [
    "task_id"
  ]
}
```

</details>

### `workflow_write_files`

State-changing, scope-limited workspace edit for a currently running built-in engineer/writer child of an approved standard-engineering v3+ workflow. Only plan-pinned relative paths are writable; each file must provide base_sha256 or ABSENT, and patch_id makes retries idempotent. No arbitrary commands, deletions, renames, symlink traversal, directory creation, custom roles or caller-supplied workspace roots. Inspect per-file receipts; reference receipt IDs in the typed task artifact. A multi-file patch can partially apply and will report that explicitly.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `task_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `patch_id` | `string` | Yes | — | pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$` |
| `writes` | `array` | Yes | — | minItems: `1`; maxItems: `16`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "task_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "patch_id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$"
    },
    "writes": {
      "type": "array",
      "minItems": 1,
      "maxItems": 16,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000
          },
          "base_sha256": {
            "type": "string",
            "pattern": "^(ABSENT|[a-f0-9]{64})$"
          },
          "content": {
            "type": "string",
            "maxLength": 2000000
          }
        },
        "required": [
          "path",
          "base_sha256",
          "content"
        ]
      }
    }
  },
  "required": [
    "job_id",
    "task_id",
    "patch_id",
    "writes"
  ]
}
```

</details>

### `execute_batch`

State-changing batch execution for 1–32 prepared, dependency-ready deterministic tasks within one approved active workflow. Use only tasks authorized for ExecutionManager; each is resolved from the immutable plan, and callers cannot supply command/args/cwd/timeout/role. Do not use for specialist reasoning tasks; inspect per-task outcomes and recover failures through the documented path.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `task_ids` | `array` | Yes | — | minItems: `1`; maxItems: `32`; unique items; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "task_ids": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "required": [
    "job_id",
    "task_ids"
  ]
}
```

</details>

### `workflow_complete_synthesis`

State-changing finalization: use only when all required tasks and evidence are ready and the coordinator has returned the synthesis contract. Record the typed CTO decision and exact success_assessment IDs/evidence_refs; the runtime independently checks task state, lineage, reviewer/QA gates and predicates. A call or narrative cannot bypass a failed gate; CASE-01 also requires the exact consumed workspace bytes.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |
| `content` | `string` | Yes | — | minLength: `1`; maxLength: `1000000` |
| `artifact` | `object` | Yes | — | — |
| `consumed_workspace_bytes` | `array` | No | — | minItems: `2`; maxItems: `2`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    },
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1000000
    },
    "artifact": {
      "type": "object"
    },
    "consumed_workspace_bytes": {
      "type": "array",
      "minItems": 2,
      "maxItems": 2,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string",
            "enum": [
              "config.json",
              "result.json"
            ]
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "encoding": {
            "type": "string",
            "enum": [
              "base64"
            ]
          },
          "bytes": {
            "type": "string",
            "maxLength": 2000000
          }
        },
        "required": [
          "path",
          "sha256",
          "encoding",
          "bytes"
        ]
      }
    }
  },
  "required": [
    "job_id",
    "content",
    "artifact"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_events`

Read-only view of a workflow's durable event history and observability summary. Use to reconstruct ordering or investigate an unexpected state; it does not change task/job state. Pair with workflow_get or workflow_diagnose when needed.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `500` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_artifacts`

Read-only listing of persisted typed artifacts and their metadata/status for a local workflow; content is redacted and bounded. Use to check artifact presence/lineage before review or synthesis, not as a replacement for schema/provenance validation.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_e2e_run`

State-changing convenience runner for deterministic local steps of an already-approved workflow. Use only when advancing deterministic tasks without host reasoning is sufficient; it never fabricates specialist results, approves a proposal, or self-approves synthesis. Use the coordinator/next-task path when specialist work is required.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |
| `max_tasks` | `integer` | No | — | minimum: `1`; maximum: `20` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    },
    "max_tasks": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_recovery_verify`

Read-only post-recovery check of persisted workflow invariants using an independent fresh Node process against the same SQLite database. Use to verify stored-state consistency; this does not prove runtime correctness, a supervisor restart, or external service health.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_record_intervention`

State-changing audit note for a real manual intervention/workaround, capturing reason and what was done for future automation. Use only after an actual intervention; it does not change workflow state, approval, or security policy and must not be used to manufacture evidence.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | No | — | — |
| `task_id` | `string` | No | — | — |
| `actor` | `string` | No | — | — |
| `reason` | `string` | Yes | — | minLength: `1` |
| `workaround` | `string` | Yes | — | minLength: `1` |
| `proposed_automation` | `string` | No | — | — |
| `duration_minutes` | `number` | No | — | minimum: `0` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string"
    },
    "task_id": {
      "type": "string"
    },
    "actor": {
      "type": "string"
    },
    "reason": {
      "type": "string",
      "minLength": 1
    },
    "workaround": {
      "type": "string",
      "minLength": 1
    },
    "proposed_automation": {
      "type": "string"
    },
    "duration_minutes": {
      "type": "number",
      "minimum": 0
    }
  },
  "required": [
    "reason",
    "workaround"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_interventions`

Read-only query of previously recorded manual interventions, optionally scoped to a workflow. Use for operational learning; it does not apply or validate a workaround.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | No | — | — |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  },
  "additionalProperties": false
}
```

</details>

### `workflow_validate_artifact`

Read-only validation of typed artifact content against a known schema/optional role. Use before persisting a candidate artifact to catch missing/invalid fields; this alone does not persist it or prove task-result lineage, approval, or overall workflow success.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `artifact_type` | `string` | Yes | — | minLength: `1` |
| `artifact` | `object` | Yes | — | — |
| `role` | `string` | No | — | — |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "artifact_type": {
      "type": "string",
      "minLength": 1
    },
    "artifact": {
      "type": "object"
    },
    "role": {
      "type": "string"
    }
  },
  "required": [
    "artifact_type",
    "artifact"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_access_diagnostics`

Read-only local diagnostics for trust/config clues relevant to CHAT_NOT_TRUSTED. Use to investigate the underlying configuration; it never bypasses or changes trust policy.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

</details>

### `custom_role_create`

State-changing creation of immutable custom role version 1. Use when a reusable specialist definition is needed; optional local Agent Skills directories/public GitHub URLs are validated and snapshotted. Treat attached skill text as supplementary, review permissions separately, and do not assume role declarations grant runtime access.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | Yes | — | minLength: `1`; maxLength: `2000` |
| `system_prompt` | `string` | Yes | — | minLength: `1`; maxLength: `12000` |
| `input_contract` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: string |
| `output_artifact_type` | `string` | Yes | — | enum: `requirements`, `research`, `architecture`, `implementation`, `security-review`, `qa-report`, `platform-review`, `documentation`, `review`, `cto-decision` |
| `allowed_capabilities` | `array` | No | — | maxItems: `32`; items: string |
| `permissions` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `allowed_tools` | `array` | No | — | maxItems: `32`; items: string |
| `skills` | `array` | No | — | maxItems: `8`; unique items; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "system_prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "output_artifact_type": {
      "type": "string",
      "enum": [
        "requirements",
        "research",
        "architecture",
        "implementation",
        "security-review",
        "qa-report",
        "platform-review",
        "documentation",
        "review",
        "cto-decision"
      ]
    },
    "allowed_capabilities": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "product.requirements",
          "research.collect",
          "architecture.design",
          "code.modify",
          "security.audit",
          "code.verify",
          "infrastructure.verify",
          "documentation.write",
          "change.review",
          "synthesis.approve"
        ]
      }
    },
    "permissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workspace.read",
          "artifact.create"
        ]
      }
    },
    "allowed_tools": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workflow_catalog",
          "workflow_list",
          "workflow_get",
          "workflow_events",
          "workflow_artifacts",
          "workflow_validate_artifact"
        ]
      }
    },
    "skills": {
      "type": "array",
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048,
        "description": "Local skill directory or public GitHub skill directory URL."
      }
    }
  },
  "required": [
    "role_id",
    "name",
    "description",
    "system_prompt",
    "input_contract",
    "output_artifact_type"
  ]
}
```

</details>

### `custom_role_update`

State-changing creation of the next immutable custom-role version; omitted fields (including skills) are retained, while skills: [] removes attachments. Existing workflow plans keep their pinned snapshots. Inspect the resulting version and use it only in newly compiled plans when appropriate.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | No | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `system_prompt` | `string` | No | — | minLength: `1`; maxLength: `12000` |
| `input_contract` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `output_artifact_type` | `string` | No | — | enum: `requirements`, `research`, `architecture`, `implementation`, `security-review`, `qa-report`, `platform-review`, `documentation`, `review`, `cto-decision` |
| `allowed_capabilities` | `array` | No | — | maxItems: `32`; items: string |
| `permissions` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `allowed_tools` | `array` | No | — | maxItems: `32`; items: string |
| `skills` | `array` | No | — | maxItems: `8`; unique items; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "system_prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "output_artifact_type": {
      "type": "string",
      "enum": [
        "requirements",
        "research",
        "architecture",
        "implementation",
        "security-review",
        "qa-report",
        "platform-review",
        "documentation",
        "review",
        "cto-decision"
      ]
    },
    "allowed_capabilities": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "product.requirements",
          "research.collect",
          "architecture.design",
          "code.modify",
          "security.audit",
          "code.verify",
          "infrastructure.verify",
          "documentation.write",
          "change.review",
          "synthesis.approve"
        ]
      }
    },
    "permissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workspace.read",
          "artifact.create"
        ]
      }
    },
    "allowed_tools": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workflow_catalog",
          "workflow_list",
          "workflow_get",
          "workflow_events",
          "workflow_artifacts",
          "workflow_validate_artifact"
        ]
      }
    },
    "skills": {
      "type": "array",
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048,
        "description": "Local skill directory or public GitHub skill directory URL."
      }
    }
  },
  "required": [
    "role_id"
  ]
}
```

</details>

### `custom_role_get`

Read-only inspection of the latest or an exact immutable custom-role version and its pinned skill metadata. Use to verify the definition before cloning or binding; this does not update permissions or grant runtime access.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "role_id"
  ]
}
```

</details>

### `custom_role_list`

Read-only list of custom roles; set include_versions to inspect immutable history. Use custom_role_get to inspect one role's content. This does not create or change roles.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `include_versions` | `boolean` | No | — | default: `false` |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "include_versions": {
      "type": "boolean",
      "default": false
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

</details>

### `custom_role_clone`

State-changing clone into a new custom-role ID. The clone preserves pinned skill snapshots unless replacement skills are supplied; review its full definition/permissions and remember its declarations do not grant runtime tool access.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `source_role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | No | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `system_prompt` | `string` | No | — | minLength: `1`; maxLength: `12000` |
| `input_contract` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `output_artifact_type` | `string` | No | — | enum: `requirements`, `research`, `architecture`, `implementation`, `security-review`, `qa-report`, `platform-review`, `documentation`, `review`, `cto-decision` |
| `allowed_capabilities` | `array` | No | — | maxItems: `32`; items: string |
| `permissions` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `allowed_tools` | `array` | No | — | maxItems: `32`; items: string |
| `skills` | `array` | No | — | maxItems: `8`; unique items; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "source_role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "system_prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "output_artifact_type": {
      "type": "string",
      "enum": [
        "requirements",
        "research",
        "architecture",
        "implementation",
        "security-review",
        "qa-report",
        "platform-review",
        "documentation",
        "review",
        "cto-decision"
      ]
    },
    "allowed_capabilities": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "product.requirements",
          "research.collect",
          "architecture.design",
          "code.modify",
          "security.audit",
          "code.verify",
          "infrastructure.verify",
          "documentation.write",
          "change.review",
          "synthesis.approve"
        ]
      }
    },
    "permissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workspace.read",
          "artifact.create"
        ]
      }
    },
    "allowed_tools": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workflow_catalog",
          "workflow_list",
          "workflow_get",
          "workflow_events",
          "workflow_artifacts",
          "workflow_validate_artifact"
        ]
      }
    },
    "skills": {
      "type": "array",
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048,
        "description": "Local skill directory or public GitHub skill directory URL."
      }
    }
  },
  "required": [
    "source_role_id",
    "role_id"
  ]
}
```

</details>

### `custom_workflow_create`

State-changing creation of immutable custom-workflow definition version 1. Use only after checking dependencies/input-output contracts; creation does not produce an executable run. Call custom_workflow_preview to compile and inspect the pinned plan before explicit approval.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `workflow_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | Yes | — | minLength: `1`; maxLength: `2000` |
| `input_contract` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: string |
| `tasks` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workflow_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "tasks": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_version": {
            "type": "integer",
            "minimum": 1
          },
          "depends_on": {
            "type": "array",
            "maxItems": 32,
            "items": {
              "type": "string"
            }
          },
          "input_contract": {
            "type": "array",
            "minItems": 1,
            "maxItems": 32,
            "items": {
              "type": "string",
              "enum": [
                "job.request",
                "requirements",
                "research",
                "architecture",
                "implementation",
                "security-review",
                "qa-report",
                "platform-review",
                "documentation",
                "review",
                "cto-decision"
              ]
            }
          },
          "output_artifact_type": {
            "type": "string",
            "enum": [
              "requirements",
              "research",
              "architecture",
              "implementation",
              "security-review",
              "qa-report",
              "platform-review",
              "documentation",
              "review",
              "cto-decision"
            ]
          }
        },
        "required": [
          "id",
          "role_id"
        ]
      }
    }
  },
  "required": [
    "workflow_id",
    "name",
    "description",
    "input_contract",
    "tasks"
  ]
}
```

</details>

### `custom_workflow_update`

State-changing creation of the next immutable custom-workflow definition version; provide the complete definition. Existing previews/runs keep pinned versions. Preview and inspect the new version before approving a run from it.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `workflow_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | Yes | — | minLength: `1`; maxLength: `2000` |
| `input_contract` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: string |
| `tasks` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workflow_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "tasks": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_version": {
            "type": "integer",
            "minimum": 1
          },
          "depends_on": {
            "type": "array",
            "maxItems": 32,
            "items": {
              "type": "string"
            }
          },
          "input_contract": {
            "type": "array",
            "minItems": 1,
            "maxItems": 32,
            "items": {
              "type": "string",
              "enum": [
                "job.request",
                "requirements",
                "research",
                "architecture",
                "implementation",
                "security-review",
                "qa-report",
                "platform-review",
                "documentation",
                "review",
                "cto-decision"
              ]
            }
          },
          "output_artifact_type": {
            "type": "string",
            "enum": [
              "requirements",
              "research",
              "architecture",
              "implementation",
              "security-review",
              "qa-report",
              "platform-review",
              "documentation",
              "review",
              "cto-decision"
            ]
          }
        },
        "required": [
          "id",
          "role_id"
        ]
      }
    }
  },
  "required": [
    "workflow_id",
    "name",
    "description",
    "input_contract",
    "tasks"
  ]
}
```

</details>

### `custom_workflow_get`

Read-only inspection of the latest or exact immutable custom-workflow definition version. Use before preview/clone/update to verify task graph and contract; this does not execute it.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `workflow_id` | `string` | Yes | — | maxLength: `80` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workflow_id": {
      "type": "string",
      "maxLength": 80
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "workflow_id"
  ]
}
```

</details>

### `custom_workflow_list`

Read-only list/search of custom workflow definitions; include_versions shows immutable history. Use custom_workflow_get to inspect a specific definition; listing does not validate or execute it.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `include_versions` | `boolean` | No | — | — |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "include_versions": {
      "type": "boolean"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

</details>

### `custom_workflow_clone`

State-changing clone into a new custom-workflow ID. Cloned tasks retain pinned custom-role versions unless a complete revised definition is supplied; preview and inspect the clone before approval or execution.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `source_workflow_id` | `string` | Yes | — | maxLength: `80` |
| `workflow_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | No | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `input_contract` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `tasks` | `array` | No | — | minItems: `1`; maxItems: `32`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "source_workflow_id": {
      "type": "string",
      "maxLength": 80
    },
    "workflow_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "tasks": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_version": {
            "type": "integer",
            "minimum": 1
          },
          "depends_on": {
            "type": "array",
            "maxItems": 32,
            "items": {
              "type": "string"
            }
          },
          "input_contract": {
            "type": "array",
            "minItems": 1,
            "maxItems": 32,
            "items": {
              "type": "string",
              "enum": [
                "job.request",
                "requirements",
                "research",
                "architecture",
                "implementation",
                "security-review",
                "qa-report",
                "platform-review",
                "documentation",
                "review",
                "cto-decision"
              ]
            }
          },
          "output_artifact_type": {
            "type": "string",
            "enum": [
              "requirements",
              "research",
              "architecture",
              "implementation",
              "security-review",
              "qa-report",
              "platform-review",
              "documentation",
              "review",
              "cto-decision"
            ]
          }
        },
        "required": [
          "id",
          "role_id"
        ]
      }
    }
  },
  "required": [
    "source_workflow_id",
    "workflow_id"
  ]
}
```

</details>

### `custom_workflow_preview`

State-changing preview creation: compile and persist an immutable custom-workflow plan with pinned role versions, validated dependencies, and hash. Review the preview before custom_workflow_approve; this does not create/approve/execute a workflow run.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `workflow_id` | `string` | Yes | — | maxLength: `80` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workflow_id": {
      "type": "string",
      "maxLength": 80
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "workflow_id"
  ]
}
```

</details>

### `custom_workflow_approve`

State-changing approval of the exact immutable custom-workflow preview after inspection and explicit user confirmation. This approves the definition preview only; custom_workflow_run_create and a separate workflow_approve for the resulting run are still required before dispatch.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `plan_id` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `confirmation` | `string` | Yes | — | minLength: `3`; maxLength: `2000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "plan_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "confirmation": {
      "type": "string",
      "minLength": 3,
      "maxLength": 2000
    }
  },
  "required": [
    "plan_id",
    "confirmation"
  ]
}
```

</details>

### `custom_workflow_run_create`

State-changing creation of a local run proposal from an already-approved immutable custom-workflow preview. Add run-specific goal/constraints/success criteria here; inspect the proposal, then call workflow_approve for the run and dispatch only after approval. This call itself does not dispatch or execute.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `plan_id` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `title` | `string` | Yes | — | minLength: `1`; maxLength: `180` |
| `request` | `string` | Yes | — | minLength: `1`; maxLength: `12000` |
| `workspace` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `goal` | `string` | No | — | minLength: `1`; maxLength: `4000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "plan_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 180
    },
    "request": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "workspace": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "goal": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "plan_id",
    "title",
    "request"
  ]
}
```

</details>

## Related guides

- [Quickstart](quickstart.md)
- [Durable batch execution](batch-execution.md)
- [Workflow policy packs](workflow-policies.md)
- [Agent Skills](agent-skills.md)
- [Local dashboard](local-dashboard.md)
- [Architecture](architecture.md)
- [Terminology and compatibility exceptions](TERMINOLOGY.md)
