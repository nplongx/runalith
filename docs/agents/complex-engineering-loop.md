# Complex engineering loop for coding agents

**Status:** Operating procedure for repository engineering work. This is not a Runalith runtime architecture change and does not grant production, approval, dispatch, or release authority.

## Purpose

Use specialist agents to complete bounded engineering work on a complex repository without turning discovery, planning, or documentation into a substitute for implementation. The Lead Agent owns one GitHub issue at a time and remains accountable for integration and acceptance. The Project Owner retains product, trust-boundary, compatibility, and release decisions.

This procedure extends [`runalith-production-readiness-loop-instructions.md`](../runalith-production-readiness-loop-instructions.md). It does not replace the live GitHub dependency graph, issue acceptance criteria, normative V2 documents, or existing safety boundaries.

## Control-plane boundary

There are two distinct layers:

- **Engineering-agent coordination:** the Lead Agent decomposes work, assigns bounded sub-tasks, collects evidence, integrates changes, and reports status.
- **Runalith runtime:** the existing LangGraph/WorkflowCompiler/WorkflowPlan, ExecutionManager, durable store, and Verifier remain the runtime control plane and authority. Do not add a second LLM Planner/Coordinator to the product runtime or let an assistant's plan override the approved workflow plan. The historical [agent architecture proposal](../agent-architecture-proposal.md) explicitly preserves this boundary.

The DAG in this document is an engineering work plan, not a workflow proposal, immutable execution plan, authorization, or dispatch instruction inside Runalith.

## Operating topology

Use **hierarchical coordination by default**. The Lead Agent is the only task owner who can decide that the issue is complete, reconcile conflicting reports, integrate patches, or update GitHub status.

| Role | Responsibility | Default access and output |
|---|---|---|
| Lead / Coordinator | Sync issue and dependencies, define DAG, assign scopes, integrate, decide next action | Repository read/write for the active task; one canonical task ledger |
| Researcher / Tracer | Trace source, callers, schemas, history, dependency edges and external references | Read-only; file/line evidence and unresolved questions |
| Architect | Convert acceptance criteria into implementation slices and dependency graph | Read-only; task contracts, risks and verification plan |
| Test Designer / QA | Define regression cases, reproduce failures, run focused and broader tests | Test scope; exact commands, exit status and captured output |
| Engineer | Implement one assigned slice | Write only within assigned file scope; patch and test evidence |
| Security / Platform Specialist | Review trust, authorization, SQL, filesystem, process, network, CI or deployment-sensitive changes | Conditional, read-only review unless a separate write task is explicitly assigned |
| Independent Reviewer / Verifier | Challenge the final diff and evidence against requirements and invariants | Read-only; blocking findings with exact evidence |

Roles are capabilities, not a requirement to spawn one agent per row. Use one agent for a small low-risk change. Add specialist roles only when risk or uncertainty requires them.

### Collaboration topology by task

- **Independent:** separate read-only traces or reviews with non-overlapping questions.
- **Sequential:** reproduce/test design → implementation → QA → independent review. Use for changes where later work depends on the exact output of earlier work.
- **Hierarchical:** default for a multi-part issue; sub-agents report to Lead and cannot mark the issue complete.
- **Broadcast:** use sparingly for short, independent audits (for example, security, compatibility, and test-scope reviews); Lead reconciles differences.
- **Joint peer debate:** avoid as the default. Unbounded peer-to-peer discussion increases context and coordination cost and has no acceptance authority.

Parallelize read-only tasks freely only when their questions are independent. Parallel code edits require explicitly isolated worktrees, known common base, disjoint write sets, and Lead-controlled integration. In a shared dirty worktree, default to one writer at a time. Never let two agents edit the same files concurrently.

## Issue decomposition and task DAG

For an issue with more than one meaningful implementation slice, create a small dependency DAG before dispatching agents. Do not create a DAG merely to make a simple task look sophisticated.

1. Convert each issue acceptance criterion into observable behavior or external evidence.
2. Build dependency facts from deterministic repository sources first: imports, symbol references, schemas, migration history, tests, package entrypoint, and explicit GitHub dependency links.
3. Use model reasoning only for unresolved relationships or semantic interpretation. Verify every model-proposed edge or claim against source, tests, or an identified owner decision. Mark anything unproven as unresolved.
4. Condense circularly dependent work into one coordinated task rather than scheduling a cycle. Do not pretend a cyclic dependency is a valid DAG.
5. Give each task the smallest sufficient context closure: its source files, direct dependencies, relevant contracts, tests, and required historical compatibility. Do not load the whole repository by default.
6. Release a task only when all direct dependencies are accepted. A failed task blocks its descendants; unrelated ready branches may continue.

Each task must use this contract (JSON is a template; the Lead may keep the live ledger in the issue plan or session):

```json
{
  "task_id": "T-01",
  "goal": "One observable engineering outcome",
  "assigned_role": "engineer",
  "mode": "write",
  "dependencies": [],
  "read_scope": ["src/module.js", "tests/module.test.js"],
  "write_scope": ["src/module.js", "tests/module.test.js"],
  "context_closure": ["relevant contract", "direct caller", "fixture"],
  "invariants": ["Existing fail-closed behavior remains unchanged"],
  "non_goals": ["No production state changes", "No unrelated refactor"],
  "acceptance_criteria": ["Observable result with an exact assertion"],
  "verification": ["Focused regression test", "Relevant integration test"],
  "deliverables": ["Patch", "Exact commands and exit codes", "Remaining unknowns"],
  "stop_conditions": ["Missing authority evidence", "Conflicting contract", "Out-of-scope write required"]
}
```

The Lead rejects a task assignment that lacks an observable outcome, write boundary, dependency declaration, or verification method. Do not mark a task complete from an agent narrative alone.

## Execution protocol: Plan → Execute → Verify

### Plan

- Keep the issue and Project #2 dependency graph as the source of truth.
- Record goal, non-goals, relevant invariants, impacted modules, task DAG, risk class, and verification commands.
- Identify the change owner and the independent verifier before implementation starts.
- Choose the smallest viable agent topology and least-privilege tool set.

### Execute

- Use test-first vertical slices: add a regression test, run it and observe the expected failure, implement the smallest fix, then rerun it.
- One Engineer owns each write scope. The Engineer does not change acceptance criteria or decide that its own work is accepted.
- Give each agent only the tools needed for its role. Research and review are read-only; code-writing tools do not imply permission to mutate production, GitHub governance, trust state, or release state.
- Refine the toolbox per task: use a direct small tool set when the catalog is small; use capability categories/hierarchical lookup for a large catalog, with semantic retrieval only to shortlist candidates. Validate each selected tool against its declared schema and role permissions. Relevance ranking never grants permission. In this chat workflow these are operating constraints, not a claim that the host enforces per-agent ACLs.
- Run commands against disposable fixtures/databases. Keep provider calls, network I/O and production operations outside test execution unless separately authorized.
- Report blockers immediately with the exact missing evidence or decision; do not keep exploring unrelated areas to avoid a blocked task.

### Verify

Use an independent verifier, not the Engineer's self-assessment. The verifier receives the original issue/acceptance criteria, applicable normative contracts, final diff, exact test commands/results and relevant source evidence. Do not rely on the Engineer's narrative or private reasoning. Do not hide necessary contracts from the verifier: independence means independent assessment, not withholding requirements.

Run this validation funnel in order, skipping a level only with a recorded reason:

| Level | Check | Required evidence |
|---|---|---|
| 1. Decomposition coverage | Every acceptance criterion maps to a task and verification result; no unowned dependency | Criterion-to-task matrix and unresolved items |
| 2. Change validity | Output schema, write scope, diff scope, forbidden operations and generated files are correct | Final diff and scope check |
| 3. Static validity | Syntax, lint/type checks and deterministic source/schema checks relevant to the change | Exact command and exit code |
| 4. Dependency/contract validity | Imports, API/schema compatibility, transaction ordering, authorization and recovery invariants remain valid | Focused contract tests and source-backed review |
| 5. Isolated execution | Unit/integration tests execute in disposable environment with no live side effects | Test output, exit code and fixture identity |
| 6. Behavioral acceptance | Regression, failure/retry, compatibility and end-to-end behavior satisfy the issue criteria | Assertions, execution evidence and independent review |

For security-critical or external-authority work, passing local levels does not substitute for independently owned trust, custody, attestation, deployment, or production evidence. Keep external gates open until that evidence exists.

## Context and memory policy

- **Task memory:** keep only the current task's source evidence, relevant messages and test feedback in the active agent context. Avoid repeatedly injecting the full issue history or unrelated inventories.
- **Durable project memory:** reuse `AGENTS.md`, `CONTEXT.md`, normative specifications, decision registers, accepted tests, and issue records. Do not create a new document for every task.
- **Instruction bootstrap:** run `node scripts/agent-instructions-preflight.mjs --target <deepest-target-directory> --format=json` before repository exploration/edits, consume its `content` field, and record its source paths and hashes. The loader resolves global + project instruction precedence and fails closed on missing root instructions, out-of-root paths/symlinks, or size overflow. For multiple target subtrees, run it once per subtree. See [preflight and runner integration](agent-instructions-preflight.md).
- **Reusable episode:** retain only a verified finding or failure signature with source location/hash or fixture identity, reproduction command, observed result, fix/decision, and known limits. Distinguish observed fact from hypothesis. Do not turn an agent's unverified suggestion into shared project truth.
- Do not create a vector database or new memory service just to imitate an architecture diagram. Existing versioned repo artifacts are the current durable memory mechanism.
- Do not persist secrets, credentials, personal data, private host state, or production database contents in agent context or memory.
- Do not transfer numeric savings, throughput, or success-rate claims from the supplied industrial-automation specification to Runalith. Establish local baselines and reproduce any claimed improvement before using it as an engineering KPI.

## Failure, quarantine and replanning

- On a failed verification, preserve the failing test/output and identify the failure signature before changing the plan.
- Stop descendants of the failed DAG node. Continue independent branches only if they do not depend on the failed assumption.
- Replan only when new evidence, a corrected hypothesis, or a changed implementation justifies it. Never repeat an identical failed command or prompt without a change in conditions.
- If the same failure signature survives two materially different remediation attempts, stop and escalate to the Lead/Project Owner with alternatives and evidence. Do not spin indefinitely.
- For missing human/authority input, pause the affected branch, preserve its task state and resume only when the exact input arrives. A pause is not permission to synthesize the missing approval or external evidence.
- Save failures as reusable signatures only after reproducing and classifying them; do not blindly avoid an old path when its cause differs.

## Risk-based routing

| Risk | Routing | Minimum verification |
|---|---|---|
| Low: isolated documentation, small pure helper, non-security behavior | One Engineer; Lead checks scope | Docs/static checks or focused unit test; diff review |
| Medium: cross-module behavior, schema/API compatibility, recovery or concurrency | Researcher/Architect → Engineer → QA → Reviewer | Regression test, integration test, compatibility and failure-path review |
| High: trust, authorization, anti-replay, checkpoint, transaction, lease, process, filesystem, provider dispatch or deployment | Read-only trace + dedicated Engineer + independent Security/Platform review + independent Verifier; human owner for external decisions | Negative tests, race/failure tests, disposable integration tests, explicit external-evidence gate |

Risk routing cannot relax the existing issue dependency graph or production safety rules.

## Current Runalith application

- Continue the existing **Sync → Select → Understand → Implement → Review → Record → Continue** issue loop. The additions here refine `Understand`, `Implement`, and `Review`; they do not create a second project-management process.
- For V2-01 / #32, use the existing caller/query registers and classification supplements as inputs. Do not regenerate inventories unless a concrete decision depends on a missing or incorrect fact. Track remaining work as bounded tasks (reader semantics, producer/query mismatches, wrappers/dynamic writers, historical schemas, deployed/shared-database reachability) with explicit evidence and blockers.
- #32 remains open until its own acceptance criteria and external/deployed reachability requirements are evidenced. #36 and #38 remain separate gates. Do not begin runtime projection until #32, #36, and #38 are each accepted.
- A source-level result cannot prove deployed worker/process inventory, shared-database completeness, independent custody, or host authority. Pause those branches at the external evidence boundary and continue only independent eligible work.
- The current dirty worktree is shared state. Preserve every pre-existing tracked and untracked change; do not overwrite, stage, commit, push, rebase, reset, clean, revert, or create concurrent edits to the same files.
- Never mutate production trust/checkpoint/ledger/workflow/task/lease/approval/dispatch state, restart a host, advance a checkpoint, activate or release a package, or weaken fail-closed behavior.

## Completion rule

A task is complete only when its patch (if any), tests, evidence, review and remaining limitations are recorded. An issue is complete only when every acceptance criterion is objectively evidenced, independent review findings are resolved, and the live GitHub dependency/project state permits acceptance. The Lead Agent reports **code changed / tests passed / review passed / external gates open** as separate facts. A document update, successful scan, or green unrelated test suite is not implementation progress.
