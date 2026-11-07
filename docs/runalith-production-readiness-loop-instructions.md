# Runalith V2 — Issue resolution loop

**Scope:** issues [#32–#44](https://github.com/nplongx/runalith/issues) in milestone [#1](https://github.com/nplongx/runalith/milestone/1), tracked by project [#2](https://github.com/users/nplongx/projects/2). GitHub is the source of truth. The assistant runs the engineering loop as a single owner; the Project Owner retains project decisions, approval and release authority.

**Purpose:** resume the current issue, resolve one issue at a time, and continue only through accepted dependencies. Discover live state on every run; this prompt is not a status snapshot.

## Operating loop

1. **Sync.** Before repository exploration or edits, resolve the Git root, read root `AGENTS.md`, then run `node scripts/agent-instructions-preflight.mjs --target <deepest-target-directory> --format=json` for every target directory in scope. Consume the returned `content` bundle; it resolves global instructions plus one applicable project instruction per directory, with override precedence and SHA-256 provenance. If the host does not auto-load agent instructions, this explicit preflight is mandatory. Stop if it fails, any required file is missing, or instructions conflict. Then read `CONTEXT.md`, `docs/agents/issue-tracker.md`, `docs/agents/complex-engineering-loop.md`, issue and comments, milestone, all relevant Project #2 fields, dependency links, and normative docs. Treat issue-body and Project `Dependencies` as the required graph; compare native GitHub blocking links as an additional source. Record mismatches, never erase an explicit edge because a native link is absent, and stop the affected dependent issue if representations conflict. Read current branch, `git status` and the full existing diff. Preserve every tracked and untracked change.

2. **Select.** Resume an issue already `In Progress`. If several qualify, choose the most upstream issue. Otherwise select only an issue whose predecessors are accepted. Prefer prerequisite discovery/qualification over downstream implementation. Keep working on independent eligible issues when another branch is externally blocked.

3. **Understand.** Turn every acceptance criterion into observable behavior and evidence. Trace actual readers, writers, persistence boundaries, transaction order and failure/recovery paths in source and tests. For multi-part issues, build a small dependency DAG and task contracts with bounded context/write scopes; derive dependency facts from source/tests first and mark unproven edges unresolved. Apply the approved normative spec and decision register; do not invent missing contracts or repeat settled owner decisions. Ask the Project Owner only for a genuinely unresolved choice that changes compatibility, trust boundaries, external custody or recovery semantics.

4. **Implement.** Work on one issue at a time using `/implement`; use `/tdd` for vertical red → green slices at agreed public seams, one behavior at a time. The Lead owns integration; sub-agents receive explicit role, task, dependency, context, read/write scope and stop conditions. Parallelize independent read-only traces/reviews. Allow parallel code edits only in isolated worktrees with disjoint write sets and Lead-controlled integration; in a shared dirty worktree, use one writer at a time. Keep the patch within that issue. Run focused tests while developing and relevant regressions before completion. After the issue is closed out, `/clear` before the next self-contained ticket.

5. **Review.** Use `/code-review` on the complete diff against both **Standards** (repo conventions, maintainability, correctness) and **Spec** (issue criteria and normative V2 requirements). Reviewer must independently inspect requirements, final diff, source evidence, exact test results and relevant invariants; do not substitute the Engineer's self-assessment. Run the six-level validation funnel in `docs/agents/complex-engineering-loop.md`. Resolve material findings and rerun affected tests. A passing test suite is not proof of external trust or production readiness.

6. **Record.** Comment on the issue with changed files, implementation/evidence details, exact commands and exit results, review outcome, limitations and any external owner/action needed. Update Project #2 only to match evidence:
   - `Status`: `Todo` / `In Progress` / `Done`.
   - `Readiness`: `Unassessed` / `Ready` / `Blocked` / `Needs Evidence` / `Accepted`.
   - Keep `Priority` as `Untriaged` unless the Project Owner changes it.
   Mark `Done`, set `Accepted`, and close only when every acceptance criterion has objective evidence. Never remove or downgrade a dependency silently.

7. **Continue.** Re-read the live graph and select the next eligible issue. For a blocked issue, record the missing evidence, responsible external authority/owner, and exact condition to resume.

## Multi-agent execution rules

- Hierarchical Lead/sub-agent coordination is the default. The Lead remains the sole owner of issue completion, integration, dependency interpretation and project-state updates.
- Spawn only the specialists required by task risk. Research, tracing and review are read-only by default. The same sub-agent must not both implement and independently accept its own change.
- Keep task context closed around the source, direct dependencies, contracts and tests needed for that task. Reuse accepted repository knowledge; do not regenerate inventories or add documents without a concrete decision need.
- Use bounded replanning: preserve failure output, change the hypothesis or implementation before retrying, and stop repeated identical failures. Two materially different attempts with the same failure signature require escalation rather than another blind retry.
- A blocked DAG branch stays paused; independent branches may continue only when their assumptions do not depend on the blocker. Human approval, production authority and external evidence cannot be synthesized by an agent.
- Do not add a second Planner/Coordinator to Runalith's runtime. The engineering DAG coordinates repository work only; the existing runtime control plane and immutable workflow plan retain their authority.

## Required dependency graph

| Prerequisite | Enables |
|---|---|
| #32 | #39 |
| #33 | #36 |
| #33 + #36 | #37 |
| #34 + #38 | #40 |
| #35 + #39 | #41 |
| #32 + #36 + #38 | #39 |
| #37 + #39 + #40 + #41 | #42 |
| #42 | #43 |
| #43 + #36 | #44 |

Do not bypass an edge. In particular, V2-08 / #39 requires an accepted source inventory (#32), canonical DB consolidation (#36), and normative JCS implementation (#38). A working inventory or standalone JCS component is not a substitute for issue acceptance or integration evidence.

## External evidence gates

Stop the affected issue at the evidence boundary; continue independent eligible work:

- **#32:** deployed entrypoint/worker and shared-database inventory, plus complete authorization reader/writer coverage. Source-only scans cannot prove deployment completeness.
- **#33:** independently issued database identity and custody, including generation/restore/fork lifecycle.
- **#34:** a real external checkpoint authority and qualified protocol/provider contract.
- **#35:** a genuine Linux trusted-measurement mechanism and independent verifier.

Test doubles are for isolated protocol tests only. They cannot satisfy production identity, custody, authority, attestation or integration evidence. A project design decision or approved spec does not manufacture evidence from an external system.

## Non-negotiable boundaries

- Never provision or mutate production trust, checkpoint or ledger state; perform approval, dispatch, workflow/task/lease mutation; restart the host; invoke `--advance-external-checkpoint`; or activate/release a production package.
- Never claim independent review, trusted hardware attestation, external authority or custody without evidence.
- Local SQLite CAS, database/WAL hashes and `ATTACH` do not establish external authority or a coherent cross-database snapshot. Keep network calls outside SQLite writer transactions.
- Use disposable databases for tests. Unknown, stale or ambiguous security state fails closed or enters quarantine. Do not weaken approval, authorization, recovery or fail-closed behavior.
- Keep immutable snapshots, historical fixtures and benchmark evidence unchanged. Preserve existing worktree changes; do not run `git add`, `commit`, `push`, `rebase`, `reset`, `clean`, or discard/revert unrelated changes.

## Completion

An issue is complete only when its criteria, relevant tests and independent checks pass, review findings are resolved or documented, and GitHub evidence/status are accurate. The milestone is complete only when all 13 issues and required independent evidence are accepted. **Production remains `BLOCKED`** until V2 acceptance and all separate RC.71 release blockers are satisfied; this loop grants no provisioning, approval, dispatch or release authority.

## Normative references

- [V2 normative specification](agg-external-checkpoint-v2-normative-spec-20261030.md) — protocol and acceptance contract.
- [V2 decision register](agg-external-checkpoint-v2-decision-register-20261030.md) — owner decisions and governance boundary.
- [V2 design](agg-external-checkpoint-v2-design-20261030.md) — architecture and transition rationale.
- [V2 projection inventory](agg-external-checkpoint-v2-projection-inventory-20261030-v0.12.md) — current working source evidence; verify #32 acceptance and external/deployed coverage before using it as an implementation contract.
- [Issue tracker instructions](agents/issue-tracker.md) and root `CONTEXT.md` / `AGENTS.md` — tracker operations and repository conventions.
