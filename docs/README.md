# Documentation

This index is the starting point for users, operators, and contributors. Visit the [Runalith project website](https://nplongx.github.io/runalith/) for an overview, then use the guides below for implementation details. Pages are grouped by the question they answer rather than by the order in which the implementation was built.

## Getting started

- [Quickstart](quickstart.md) — build or connect the local MCP runtime and understand the first workflow steps.
- [Production-readiness loop instructions](runalith-production-readiness-loop-instructions.md) — reusable, version-agnostic iteration prompt that discovers the current candidate/evidence on every run and preserves production safety boundaries.
- [Root README](../README.md) — project purpose, capabilities, security boundaries, commands, and navigation.
- [Testing pre-release notes for 1.0.9-rc.11](release-notes-1.0.9-rc.11.md) — published package identity, validation scope, production blockers and the no-install boundary for the current candidate.
- [RC.11 Goal/Idea → Plan → Execution Graph acceptance (2026-10-26)](goal-plan-execution-acceptance-rc11-20261026.md) — exact tag/source/package identity, release-time verification, current host observations and authority-owned blockers.
- [RC.11 workflow recovery guidance](goal-plan-execution-recovery-guidance-rc11-followup.md) — read-only reconciliation procedure and safe owner/provider recovery boundary.
- [Historical RC.5 testing pre-release notes](release-notes-1.0.9-rc.5.md) — older package identity and testing boundaries; not the current release.
- [Local RC.5 installation verification (2026-10-20)](installation-verification-1.0.9-rc.5-20261020.md) — evidence for a separate workspace-built candidate and installed file-content comparison; not the published release asset or release approval.
- [RC.7 rollout readiness and rollback runbook](runalith-rollout-rc7.md) — versioned runtime identity, non-mutating preflight, installed-generation rollback snapshots, simulated switch/recovery, and explicit host-managed activation gates.
- [RC.7 rollout-readiness evidence (2026-10-26)](rollout-readiness-1.0.9-rc.7-20261026.md) — candidate/rollback hashes, current host gate, live workflow counters, and exact missing evidence contracts for all nine Plan Graph steps.
- [RC.8 rollout readiness and rollback runbook](runalith-rollout-rc8.md) — historical RC.8 candidate-specific procedure; not activation approval for RC.11.
- [RC.8 rollout-readiness evidence (2026-10-26)](rollout-readiness-1.0.9-rc.8-20261026.md) — historical candidate identities and scoped acceptance evidence; consult the RC.11 acceptance record for current package identity and blockers.

## Using the runtime

- [Workflow lifecycle and recovery](workflow-lifecycle.md) — proposal, explicit approval, task execution, diagnosing blockers, rework, and synthesis.
- [Hybrid engineering workflow](hybrid-engineering-workflow.md) — combine specialist reasoning with plan-bound deterministic execution.
- [Durable batch execution](batch-execution.md) — the `execute_batch` input contract, preconditions, result evidence, and limitations.
- [Agent Skills](agent-skills.md) — skill format, import sources, immutable snapshots, role bindings, and security limits.
- [Workflow policies](workflow-policies.md) — supported predicates, policy versions, attachment timing, evaluation, and audit behavior.
- [Local dashboard](local-dashboard.md) — start and configure the read-only UI, endpoints, and security boundaries.
- [MCP tool reference](MCP_REFERENCE.md) — generated tool index and full input schemas from the current `tools/list` response.
- [Terminology and naming compatibility](TERMINOLOGY.md) — product terminology and identifiers retained for compatibility.

## Understanding the implementation

- [Architecture](architecture.md) — runtime components, durable state, execution, and recovery boundaries.
- [Adaptive Goal Graph system guide](adaptive-goal-graph.md) — current AGG architecture end-to-end: bounded graph search, persistent Goal/Idea knowledge, evidence lineage, independent verifier/reviewer trust, Plan/Execution Graph integration, telemetry, experiments and hard execution boundaries.
- [Runalith production readiness and workflow engineering decision record (2026-10-28)](runalith-production-readiness-workflow-engineering-20261028.md) — candidate-specific blocker evidence contracts, trust/approval architecture, read-only workflow reconciliation metrics, durability patterns, workflow-engine trade-offs, negative tests and phased go/no-go criteria. This record does not authorize release or close a production gate.
- [RC.32 rollout dossier (2026-10-28)](runalith-rollout-rc32-20261028.md) and [Goal/Idea → Plan → Execution acceptance (RC.32)](goal-plan-execution-acceptance-rc32-20261028.md) — integrated cancellation hardening, versioned trust-preflight diagnostics, current read-only lifecycle findings and the remaining authority-owned release gates.
- [RC.37 rollout dossier (2026-10-28)](runalith-rollout-rc37-20261028.md) — schema-v2 per-record recovery lineage, bounded event-reference scanning, reviewer-trust-missing dispatch regression, candidate-bound validation and all still-open external authority gates.
- [RC.38 rollout dossier (2026-10-28)](runalith-rollout-rc38-20261028.md) — combines current graph and lifecycle reconciliation reports into separately hash-bound, per-record remediation, while requiring same-DB identity, fresh observation time and diagnostic-only policy.
- [RC.39 rollout dossier (2026-10-28)](runalith-rollout-rc39-20261028.md) — requires an explicit negative assertion for external-security-store mutation in schema-v2 lifecycle input and tests fail-closed behavior for a missing marker.
- [RC.40 rollout dossier (2026-10-28)](runalith-rollout-rc40-20261028.md) — adds a package contract for exact manifest MCP launch arguments and aligns `mcp_config.args`, `main`, `npm start` and the versioned runtime entry point.
- [RC.41 rollout dossier (2026-10-29)](runalith-rollout-rc41-20261029.md) — lifecycle send-claim/reaper race fixes and packaged provider-pre-send regression coverage. Local candidate only; rollout remains blocked pending independent authority evidence and workflow drain.
- [AGG production trust provisioning runbook](agg-production-trust-provisioning-runbook.md) — administrator-owned public roots, JSON configuration, independent providers, rotation/revocation and the missing external monotonic checkpoint gate.
- [RC.11 Goal/Idea → Plan → Execution acceptance](goal-plan-execution-acceptance-rc11-20261026.md) — published candidate identity and current read-only host blockers; does not authorize installation/activation.
- [RC.11 workflow recovery guidance](goal-plan-execution-recovery-guidance-rc11-followup.md) — per-job/task read-only reconciliation and owner/provider-authorized recovery procedure.
- [AGG Phase 1 benchmark methodology](agg-phase1-benchmark-methodology.md) and [owner next steps (Vietnamese)](agg-phase1-owner-next-steps-vi.md) — benchmark evidence protocol, unclosed acceptance requirements and operator handoff.
- [AGG empirical evaluation](research/agg-empirical-evaluation/README.md) — reproducible research artifacts, measured results, sample/corpus limits and claims not supported by current data.
- [Architecture illustrations](diagrams/README.md) — GitHub-rendered static PNGs that supplement the written explanation.
- [Release policy](RELEASE_POLICY.md) — minimum checks for experimental GitHub pre-releases versus formal frozen/production releases.
- [Known issues and release blockers](KNOWN_ISSUES.md) — current limits and outstanding gates; this is not a general feature roadmap.

## Contributing and maintaining documentation

- [Contributing guide](../CONTRIBUTING.md) — development environment, tests, safety, and pull request expectations.
- [Documentation rewrite workflow](DOCUMENTATION_WORKFLOW.md) — how to inventory, classify, write, verify, review, and maintain docs.
- [Security policy](../SECURITY.md) — reporting process and security boundaries.
- [Changelog](../CHANGELOG.md) — user-visible changes by release/candidate.

## Engineering plans and historical records

The remaining milestone (`m*`), phase (`p*`), proposal, implementation-plan, benchmark, and evidence files document development history or a scoped engineering effort. They are not current usage instructions by default and must not be treated as a single current specification. Before relying on one, check its scope and stated status, then verify behavior against the shipped code and tests. A plan or evidence packet is not proof that a feature is currently shipped or release-authorized. Do not modify historical evidence to make current status look cleaner.

### Architecture and design proposals

| Record | Intended use | Reading caution |
|---|---|---|
| [Agent architecture proposal](agent-architecture-proposal.md) | Historical design rationale and role/orchestration proposal | A proposal is not a contract for every current runtime path. |
| [M0 architecture freeze](m0-architecture-freeze.md) | Baseline architecture and compatibility decisions | Freeze/milestone language describes its original scope; verify current invariants in code. |
| [M1 agent contract layer](m1-agent-contract-layer.md) | Earlier agent contract design | Later milestones may change enforcement; inspect the current contract modules and tests. |
| [M3 requirements/research/architecture](m3-requirements-research-architecture.md), [M4 engineer](m4-engineer.md), [M4 progress](m4-progress.md), [M5 specialist verification](m5-specialist-verification.md), [M6 reviewer](m6-reviewer.md), [M7 CTO](m7-cto.md), [M8 recovery/idempotency](m8-rework-recovery-idempotency.md), [M9 governance/permissions](m9-governance-permissions.md), [M10 observability](m10-observability.md) | Historical milestone contracts and progress notes | Use as milestone-specific design context, not as a substitute for current runtime tests. |
| [M11 native E2E plan](m11-native-e2e.md), [M11 QA evidence](m11-qa-worker-6-evidence.md) | Runner-boundary design and a dated QA record | The QA record describes its own test context; do not generalize it to current live integration. |
| [M12 broker architecture](m12-broker-architecture.md), [M12 native specialist bridge](m12-native-specialist-bridge.md), [M12 phase 1 patch notes](m12-phase1-openclaw-2026.9.5-patch.md), [M12 gateway admission](m12-phase1b-gateway-admission.md), [M12 core hook](m12-phase1b-openclaw-core-hook.md), [M12 phase 3 plan](m12-phase3-implementation-plan.md), [M12 production runner rollout](m12-production-runner-rollout.md) | Distributed-worker/native Gateway integration plans and contracts | These are separate from the local plugin mode unless a shipped integration and live acceptance evidence prove otherwise. |

### Distributed execution phases and benchmark records

| Record group | Files | Reading caution |
|---|---|---|
| P0–P4 contracts and runner setup | [P0 execution contract](p0-execution-contract.md), [P1 runner smoke](p1-runner-smoke.md), [P2 GitHub Actions provider](p2-github-actions-provider.md), [P3 worker protocol](p3-worker-protocol.md), [P4 evidence verifier](p4-evidence-verifier.md) | These describe phase-specific interfaces and evidence. They do not by themselves enable remote execution in the shipped local plugin. |
| P5–P9 distributed scheduling and delivery | [P5 task leases](p5-task-leases.md), [P6 distributed scheduler](p6-distributed-scheduler.md), [P7 LangGraph control loop](p7-langgraph-control-loop.md), [P8 autonomous delivery](p8-autonomous-delivery.md), [P9 resumable execution](p9-resumable-execution.md) | Check present code, deployment configuration, and live evidence before claiming these paths are operational. |
| P10–P14 performance and hardening | [P10 capacity benchmark](p10-capacity-benchmark.md), [P11 security hardening](p11-security-hardening.md), [P12 observability](p12-observability.md), [P13 failure injection](p13-failure-injection.md), [P14 idempotency audit](p14-idempotency-audit.md) | A plan, simulation, or audit packet is scoped evidence, not a blanket production certification. |
| Distributed provider integration | [GitHub Actions distributed-worker plan](github-actions-distributed-worker-implementation-plan.md), [GitHub Actions/OpenClaw contract matrix](github-actions-openclaw-contract-matrix.md) | The contract matrix explicitly records missing/unproven native Gateway requirements; do not infer a native provider from the presence of an adapter. |
| Workflow benchmark | [Benchmark plan](plugin-workflow-benchmark-plan.md), [tracked benchmark repository README](../benchmarks/plugin-workflow-benchmark/README.md), [paired-host harness contract](../benchmarks/plugin-workflow-benchmark/paired-host-harness-contract.md) | Keep benchmark identity and authorization separate from general test results. Local, ignored phase-freeze/preflight copies are not links for GitHub readers. Consult [known issues](KNOWN_ISSUES.md) for current release blockers. |

Use the [release policy](RELEASE_POLICY.md) to distinguish testing pre-releases from the production/frozen-release lane, [known issues](KNOWN_ISSUES.md) and the [RC.11 acceptance record](goal-plan-execution-acceptance-rc11-20261026.md) for current limitations, the [`1.0.9-rc.4` candidate record](review-candidate-1.0.9-rc.4.md) for historical RC.4 artifact evidence, and the [local RC.5 installation verification](installation-verification-1.0.9-rc.5-20261020.md) for that separately built local candidate. A testing pre-release or successful post-install smoke check does not satisfy or override formal production release gates.

## Where facts come from

Runtime behavior is defined by the shipped MCP entrypoint, workflow contracts, storage and execution implementation, schemas, and tests. Documentation describes that behavior; it does not override it. If a page conflicts with the implementation, record the discrepancy and resolve it before presenting the claim as current.
