# Terminology and naming compatibility

Runalith uses host-neutral product language. The MCPB package format is a bundle container; the MCP server identity, runtime semantics, and client integration are separate concepts. This guide distinguishes user-facing descriptions from identifiers that remain necessary for compatibility or historical evidence.

## Preferred wording

| Preferred explanatory wording | Exact identifier when needed | Notes |
|---|---|---|
| **Runalith runtime** | `runalith-agent-orchestrator` | Current MCP server identity and package name. |
| **MCP bundle** or **MCPB** | `.mcpb`, bundle-root `manifest.json` | A package/container format, not a claim of vendor-specific behavior. Client-side installation support varies. |
| **MCP stdio server** | `server/index-v1.0.9-rc.11.js` for this RC.11 checkout; `server/index.js` is historical/compatibility input | The direct integration path for clients that launch local stdio servers. Follow `package.json` for the checked-out package's selected versioned entrypoint; historical paths and evidence must not be silently rewritten. |
| **Local dashboard** | `dashboard/public/`, existing `/api/...` routes | Read-only local UI. Do not rename routes, browser storage keys, or database identifiers in a documentation-only change. |
| **Workflow run** or **workflow** | `job_id`, `workflow_create`, `workflow_dispatch` | “Run” describes the user's workflow instance; code and tool names retain their exact spelling. |
| **Adaptive Goal Graph (AGG)** | `adaptive_goal_*`, `src/runtime/adaptive-goal-*.js` | A graph-planning, persistent knowledge, evidence and proposal subsystem; not a separate general-purpose execution engine. See the [AGG system guide](adaptive-goal-graph.md). |
| **Goal/Idea Graph** or **knowledge graph** | `adaptive_goal_knowledge_*`, `goal_id`, `stable_key`, `revision`, `membership` | Persisted versioned nodes, typed edges, cross-goal membership and provenance. Saving or retrieving a node does not make its claims verified or planning-eligible. |
| **Plan Graph draft/proposal** | `adaptive_goal_plan_*`, `adaptive_goal_plan_graph_draft` | A candidate path mapped onto an existing workflow template for review. It is not an immutable workflow execution plan and does not authorize dispatch. |
| **Execution Graph proposal** | `adaptive_goal_execution_graph_proposal_*` | A review-only action/task mapping checked against role contracts, DAG ancestry and durable evidence lineage. It is not a standalone executable graph. |
| **Knowledge snapshot attestation** | `adaptive_goal_knowledge_snapshot_get`, `adaptive_goal_knowledge_snapshot_attest`, `adaptive_goal_knowledge_graph_search` | An external verifier's signed decision bound to the exact current graph snapshot and evidence manifest. This differs from a candidate hash or reviewer identity attestation. |
| **Reviewer identity attestation** | `adaptive_goal_execution_plan_candidate_*`, `adaptive_goal.action_intent.review` | An independently trusted provider's signature bound to the exact candidate, semantics, inputs, role contract and immutable plan. It is not normal workflow approval. |
| **Evidence lineage** | artifact ID/hash, `artifact.created`, producer result/attempt, task completion event | Provenance chain showing which durable artifacts came from which successful producer execution. Lineage/hash integrity does not by itself prove claim truth or evidence independence. |
| **AGG algorithm Phase 2/3/4** | discriminator shadow search, MCTS shadow search, workflow-outcome capture | Experimental AGG algorithm phases. These names are distinct from the formal Runalith Phase 2 deployment-readiness gate; the shadow/capture tools are disabled by default. |
| **Custom role profile** | `custom_role_id`, `custom_role_version`, `custom_role_create` | Use generic wording in prose, but preserve API fields and role IDs in examples. |
| **Agent Skill** | `SKILL.md`, `skills`, `custom_role_update` | The upstream skill format is retained; do not invent another file format or change property names. |
| **Execution record** | `ExecutionManager`, `execute_batch`, `task_execute_local` | Preserve internal class names where source tracing or debugging requires them. |
| **Read-only reconciliation report** | `scripts/reconcile-active-workflows.mjs`, `adaptiveGoalGraph`, `recoveryPlan` | Correlates durable workflow lineage and inventories Goal/Idea graph snapshot freshness; it does not verify external signatures or authorize lifecycle changes. |
| **Policy pack** | `workflow_policy_*`, policy IDs and version fields | A reusable versioned definition; it does not grant permissions and only catalogued predicates are enforced. |
| **Explicit approval** | `workflow_approve`, plan hash, approval events | Proposal creation and preview are not approval. Keep this distinction explicit. |
| **Historical engineering record** | `M0`, `M11`, `M12`, `P0`–`P14`, case IDs, evidence filenames | These identify particular milestones, tests and records. Do not rewrite literal identifiers inside source evidence. |

## Compatibility boundary

These strings can be externally observable or operationally significant. Do not mass-rename them without a separately reviewed migration, compatibility and test plan:

- MCP tool names and arguments, workflow/template IDs, built-in role IDs, custom role IDs, artifact types, enum values and JSON protocol fields.
- SQLite schema/table/column names, stored events, record IDs, hashes, signed authorizations, benchmark identities and historical artifact identities.
- Existing environment-variable names and data paths. The neutral `RUNALITH_*` variables are the preferred documentation surface; legacy aliases remain accepted for backward compatibility.
- Historical filenames that identify the pre-rebrand frozen package and the scripts that verify that exact artifact. They are not the current Runalith package name.

Historical benchmark evidence may still contain exact identifiers from the software and host environment that were observed at that time. Do not change a recorded hash or represent an old artifact as a newly branded build. Public product copy should use Runalith and refer to historical materials only where their provenance matters.

## Custom role ID examples

Custom role IDs are local database records, not populated by copying a documentation example:

```json
{
  "role": "engineer",
  "custom_role_id": "example-implementation-specialist",
  "custom_role_version": 1
}
```

Create/import the role first and replace the placeholder with the exact ID and version that exists in the target database. Never rewrite a literal stored ID to match a placeholder.

## Naming-change rules

1. Search source, docs, tests, manifests, UI text, routes, storage keys and generated/package inputs before changing a term.
2. Classify occurrences as descriptive copy, public contract, stored/compatibility identifier, upstream proper name or historical evidence.
3. Change descriptive copy and current public package identity; preserve immutable historical identities and compatibility paths.
4. Run `npm run docs:check`, `git diff --check`, and focused UI/API/contract tests for the affected surface.
5. For any protocol or stored-identifier migration, prepare a separately reviewed migration plan instead of mixing it into a documentation change.
