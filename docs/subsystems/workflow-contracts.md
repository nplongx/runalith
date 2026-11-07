# Workflow contracts subsystem

**Status:** partial pure contract kernel extracted to [runalith-workflow-contracts](https://github.com/nplongx/runalith-workflow-contracts) (public MIT repository, package `0.1.0`, CI passed on Node 22/24). The full workflow-definition/compiler/policy boundary remains inside the host; built-in role/action-intent vocabulary has its own package.

## Current implementation

The extracted pure kernel is limited to:

- `src/runtime/workflow/artifacts.js` — typed artifact DTO content validation, safe JSON snapshotting and SHA-256 content identity.
- `src/runtime/workflow/success-contract.js` — typed success-contract normalization, caller-supplied read-model evaluation and success-assessment validation.
- `src/runtime/strict-json.js` — duplicate-decoded-key-aware JSON parser used by success-contract evaluation.

Public root API: `https://github.com/nplongx/runalith-workflow-contracts/blob/main/API.md`. The host retains byte-identical local source copies and verifies them against the public commit/hash manifest; host runtime does not load the package over the network or depend on an npm install.

Other workflow modules remain in `src/runtime/workflow/`: `schema.js`, `plan.js`, `compiler.js`, workflow definitions/catalogs, role profiles and policy-related contracts. Pure built-in role/action-intent declarations are separately mirrored through [Agent Contracts](agent-contracts.md). The host-only [Workflow Plan API v1 facade](../../src/runtime/workflow-plan-public-api.js) exposes frozen plan canonicalization/validation, task-dependency matching and batch-route resolution to host consumers; it is not part of the extracted `runalith-workflow-contracts` package and carries no persistence or lifecycle authority.

The remaining long-term workflow boundary may include workflow definitions, canonical plan representation, plan validation/compilation and policy/custom-role persistence adapters after their dependencies are neutralized. The public package today does **not** claim those boundaries. It excludes lifecycle state, SQL persistence, dispatch, host transports and provider execution. Pure role/action-intent declarations have their own public package, but workflow definitions/compiler and compiled AGG semantic verification remain host-bound.

## Candidate public API

The public API currently exports:

- `ArtifactType`, `ArtifactStatus`
- `hashArtifactContent`, `createArtifactRecord`, `validateArtifact`, `validateArtifactContent`, `artifactSchemaForType`
- `normalizeSuccessContract`, `validateSuccessContract`, `hasEnforcedSuccessCriteria`
- `evaluateSuccessPredicate`, `validateSuccessAssessment`, `successContractPrompt`
- `MAX_STRICT_JSON_BYTES`, `parseStrictJson`

See the package API reference for exact DTO shape and validation semantics. Package `0.1.0` is experimental. Evaluation uses read models supplied by the caller; it does not independently verify durable task/artifact lineage or trust.

## Coupling to resolve

- AGG consumers now import the host Workflow Plan API v1 and Agent Contracts root API rather than deep `workflow/plan.js` or `workflow/agent-contracts.js` modules. Workflow definitions/compiler, policy persistence, artifact stores and lifecycle transactions remain host-owned.
- `src/runtime/workflow/agent-contracts.js` is now a compatibility adapter: pure role/action-intent contracts come from `agent-contracts-public-api.js`; compiled structural validation stays in Workflow, while AGG semantic verification is injected by the composition host through `configureCompiledActionIntentSemanticVerifier`. Candidate event interpretation and evidence-lineage resolution moved to `adaptive-goal-action-intent-binding-resolver.js`; it consumes WorkflowStatePort read APIs. The host composes that resolver through `setAdaptiveGoalActionIntentBindingsResolver`. Do not move AGG semantic policy into either pure contracts package.
- Policy/custom-role/custom-workflow modules include persistence concerns and should not be moved into a pure contracts package without separating their stores from their DTO/schema logic.
- Runtime consumers retain the compatibility module path; package consumers use the root export. Some tests/scripts still import host implementation paths directly.
- `plan.js` imports `policy-contract.js`, `role-profiles.js` and workspace-write semantics; `policy-contract.js` mixes pure rule validation with DB-backed registries; workflow catalogs also include filesystem/process configuration. Keep these modules host-owned until split.

## Dependency policy

Allowed: platform-neutral value types, COS-AP types only where genuinely needed, and stable domain contracts.

Forbidden: `job-store.js`, `WorkflowStore.db`, server entrypoints, provider adapters, trust DB handles, raw SQLite rows and filesystem/process APIs.

## Documentation

The extracted package maintains a README, API reference, security/contribution policies, changelog, synthetic tests and Node 22/24 CI. The README links back to the host subsystem map and this page. A future workflow compiler package will need a separate package/repository decision and its own compatibility/consumer migration gates.
