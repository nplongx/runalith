# Repository extraction sequence

Separate logical subsystem, package, GitHub repository, process and database are different boundaries. The canonical target repositories, ownership map, dependency graph and extraction order live in the [GitHub repository target map](github-repository-target-map.md). This document defines the extraction procedure and quality gates; do not maintain a competing repo catalog here.

## Proposed repository candidates

Four pure public subsystem repositories already exist. The stateful target repositories below remain proposals; see the canonical map for complete source ownership and blockers:

| Order | Proposed repository | Scope | Readiness |
|---:|---|---|---|
| 1 | [`runalith-cos-ap`](https://github.com/nplongx/runalith-cos-ap) | COS-AP wire and durable execution contract package | **Public MIT repo; CI passed.** Package `0.1.0` experimental; npm publication and cross-repo host sync remain open. README at pinned commit incorrectly says no GitHub repository exists; host catalog and remote repository are verified. |
| 2 | [`runalith-adaptive-goal-graph-core`](https://github.com/nplongx/runalith-adaptive-goal-graph-core) | Pure graph schema/validation/search, offline discriminator; Phase 2/3 under `./experimental` | **Public MIT repo; CI passed on Node 22/24.** Package `0.1.0` experimental; host knowledge/trust/proposal adapters are not included; no npm publication. |
| 3 | [`runalith-workflow-contracts`](https://github.com/nplongx/runalith-workflow-contracts) | Pure artifact DTO, success predicates and strict JSON parser | **Public MIT repo; CI passed on Node 22/24.** Package `0.1.0` experimental. Workflow definitions/compiler, custom-role profiles and policy stores are explicitly excluded; full workflow extraction remains blocked. |
| 4 | [`runalith-agent-contracts`](https://github.com/nplongx/runalith-agent-contracts) | Pure built-in role/action-intent vocabulary and generic normalization | **Public MIT repo; Node 22/24 CI passed.** Package `0.1.0` experimental; compiled AGG semantic verification remains host-side. |
| 5 | `runalith-workflow-runtime` | Workflow definitions, compiler, policy and authoritative workflow lifecycle | WorkflowStatePort v2 and explicit host injection are in place; final execution spawn authorization is one Workflow-owned atomic command. WorkflowStore still owns Execution schemas/transactions and the shared event journal. Workflow/Agent lifecycle operations still share same-DB transaction participants; OpenClaw identity projections and host integrations remain. |
| 6 | `runalith-trust-evidence` | Trust configuration, signature verification, reviewer identity, evidence and checkpoint contracts | High-risk; blocked by Workflow persistence coupling and open D-01 database-identity/continuity requirements. |
| 7 | `runalith-execution-runtime` | Plan-bound execution, providers, leases, dispatch and recovery | ExecutionManager, RecoveryManager, scheduler and provider adapters receive WorkflowStatePort v2 explicitly; ExecutionPersistenceStore v1 owns provider-run/dispatch-intent DDL, reads, intent reservation, provider-only outcome writes, run persistence/binding and no-send claim release. Cross-domain send/result/lease fences and attempts/results/batches still share WorkflowStatePort/WorkflowStore transactions. Blocked by remaining physical schema ownership, lease/attempt/event coupling and M12 unknown-outcome recovery. |
| 8 | `runalith-workspace-runtime` | Secure file writes, receipts, CASE-01 snapshots and consumption acknowledgement | Workspace Write service exists; CASE-01 orchestration and cross-owner consistency remain. |
| 9 | `runalith-adaptive-goal-runtime` | Stateful AGG knowledge, proposals, candidates, readiness and sandbox use cases | AGG consumers now use Workflow Plan API v1 and Agent Contracts public API rather than private Workflow plan/agent-contract modules. Still blocked by Workflow/Trust persistence coupling and MCP-owned compound operations. |
| 10 | `runalith-agent-runtime` | Agent control loops, sessions and external runtime integrations | AgentSessionStore owns session/ACL/message DDL+SQL; `RunalithWorkflowStore` host composition constructs it and exposes domain API v1 separately from internal lifecycle transaction participant. Constructor rejects a WorkflowStatePort backed by a different SQLite connection. WorkflowStore core has no Agent Session construction or public delegators; private injected ports still share same DB/FKs/events and task/session references. Standalone dependency closure remains incomplete. |
| 11 | `runalith-api-adapters` | MCP/HTTP transports, Slack and external OpenClaw channel adapters, tool schemas and DTO mapping | Last; only after handlers call stable subsystem APIs and delivery state has an owner API. |
| 12 | `runalith-dashboard` | Read-only dashboard UI and projections | Extract after read-only query/projection API is stable. |

## Public repository reconciliation (2026-11-01)

The four public repositories are reachable and their remote `main`/HEAD commits match the pinned commits in [`public-repository-snapshots.json`](public-repository-snapshots.json). Every curated host snapshot file was fetched from its corresponding remote path at that exact commit and SHA-256 matched byte-for-byte. CI runs for those exact commits are completed successfully:

| Repository | Pinned commit | Curated files | CI |
|---|---|---:|---|
| [`runalith-cos-ap`](https://github.com/nplongx/runalith-cos-ap) | `b6f2b51d549ba2f287ebd49d18ce29a212b2270a` | 16 | `COS-AP CI` success |
| [`runalith-adaptive-goal-graph-core`](https://github.com/nplongx/runalith-adaptive-goal-graph-core) | `d329718731faa8c8adab9fc5f1661ef801b98353` | 6 | `CI` success |
| [`runalith-workflow-contracts`](https://github.com/nplongx/runalith-workflow-contracts) | `0419b17985500e3d9b3aa18e07c0b2f6b010070b` | 3 | `CI` success |
| [`runalith-agent-contracts`](https://github.com/nplongx/runalith-agent-contracts) | `7253657b5c3e2815cd21afed08d1e7027510d866` | 1 | `CI` success |

The GitHub roadmap was re-read without mutation: Project #3 `Runalith — Subsystem Extraction Roadmap`, Roadmap view #3, repository Milestone #2 `Subsystem Extraction — Bounded Repository Program` OPEN with 13 open / 0 closed issues. Parent #45 and host-integration #57 remain OPEN and unassigned. Project items remain 13; no status, field, issue, milestone, view or dependency relationship was edited.

Evidence prepared for #45 includes the explicit stateful-subsystem readiness matrix, provider-ledger write ownership transfer and refreshed live/authority blockers. Evidence prepared for #57 includes the packed COS-AP installed-consumer contract in package CI, reproducibility/source-alignment checks and a seven-archive RC.72 inventory. #57 remains blocked: no stateful subsystem releases are pinned as dependencies, no independent Workflow/Execution/Agent Session CI exists, and the extant RC.72-named archives fail source alignment.

All four package manifests report experimental `0.1.0`; the remote packages have Node 22.13+ engines, public root exports and repository-local tests/CI. No npm publication or host dependency migration is configured. The owner decision between continued pinned-snapshot consumption and versioned package/release consumption remains open; no release policy was inferred. The COS-AP README at its pinned commit still says the repository has not been created, despite the reachable repository, remote tree, package manifest and successful CI run. This is an upstream documentation defect; the host mirror is kept byte-identical rather than silently edited.

## Delivery stages

### Stage 0 — Baseline and catalog

Inventory imports, callers, tables, transactions, tests, protocol schemas and docs. Mark all dependencies as observed or unresolved. Preserve historical evidence and existing worktree changes.

### Stage 1 — Public API in the monorepo

Give a candidate one package root, explicit exports, self-contained README/API reference, schema fixtures, standalone tests and path-scoped CI. Host consumers call only that public entrypoint. No separate process/database yet.

### Stage 2 — Enforce dependency direction

Add import-boundary checks. Replace deep imports and reverse dependencies with public APIs or neutral contracts. Keep adapters inside the host while contracts stabilize.

### Stage 3 — Separate data ownership

Move each stateful subsystem behind an owner-controlled store port. For cross-owner workflows, define durable events/outbox, idempotent commands, retries, compensation and reconciliation. Verify crash/race behavior in disposable databases.

### Stage 4 — Extract GitHub repository

From a clean, reviewed source snapshot, split package history into a new repository. Give it its own MIT license, README, API docs, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, changelog, tests and CI. Add links in both directions. Do not publish experimental or security-sensitive internals without a scope/secret review.

### Stage 5 — Independent release and optional process split

Publish a versioned package/release after compatibility and security review. Run consumer/provider contract tests against the new release. A process or database split is separate and requires measured operational value plus the Stage 3 ownership/consistency gates.

## Repository quality gates

- Standalone clean checkout can install/build/test without the parent repository.
- Public exports and JSON schemas are explicit; no deep import is required.
- API docs are generated/checked against the contract where possible.
- CI covers supported Node versions and contract fixtures.
- Consumer compatibility and package provenance are recorded.
- License, contribution, security and conduct files are present.
- Release/version/deprecation policy is explicit.
- Parent and subsystem documentation cross-link to exact versioned APIs.

Run `node scripts/verify-subsystem-extraction-readiness.mjs --out <new-report.json>` to execute local boundary, package, Goal/Idea producer-to-dispatch negative, reviewer/approval, trust/checkpoint, execution concurrency/recovery, historical archive, AGG V2 provenance, reproducibility, MCPB alignment and documentation checks and emit machine-readable evidence. The runner deliberately returns exit code `3` / `BLOCKED` while Workflow, Execution or Agent Session remain non-standalone; local green tests cannot clear missing persistence ownership, independent release/version/rollback or authority gates. It checks local pinned snapshot bytes but does not contact remote GitHub heads or claim remote CI was re-run.

The COS-AP candidate now has an installed-tarball consumer check: `node scripts/test-cos-ap-packed-consumer.mjs` packs version `0.1.0`, installs the exact tarball into an isolated consumer and exercises the public root export plus all six packaged schemas. The host's `.github/workflows/cos-ap-package.yml` runs this after package source tests. This closes the artifact-consumer check for COS-AP only; it does not establish stable 1.0 compatibility, change the public repository, or establish independent release authority.

All four public repositories were extracted from curated package-only snapshots in isolated staging directories. `runalith-adaptive-goal-graph-core` contains six pure source modules (graph, discriminator, Phase 2 search/dataset, Phase 3 MCTS and canonical JSON), explicit root/experimental exports, standalone synthetic contract tests and Node 22/24 CI. `runalith-workflow-contracts` contains the pure artifact DTO, success-contract and strict-JSON parser closure; `runalith-agent-contracts` contains pure role/action-intent declarations and normalizers, while AGG compiled semantic validation remains host-side; it deliberately excludes full workflow definitions/compiler and DB-backed policy stores. The pure packages have no WorkflowStore, MCP, trust, provider, filesystem or external runtime dependencies. The host continues to use its own source copies; automated cross-repo synchronization and npm publication are not configured. The host runs an offline hash alignment test against exact public commits; see [`public-repository-snapshots.json`](public-repository-snapshots.json). This detects drift but does not fetch or sync remote changes. Host worktree remains uncommitted/unpushed and was not used as the source of an unfiltered repository mirror. Remaining stateful candidates require the same bounded extraction process only after ownership and consistency gates pass.
