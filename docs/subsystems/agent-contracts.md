# Agent Contracts subsystem

**Status:** pure built-in role and action-intent vocabulary extracted to [runalith-agent-contracts](https://github.com/nplongx/runalith-agent-contracts), public MIT repository, package `@runalith/agent-contracts@0.1.0` (experimental). Independent Node 22/24 CI passed. npm publication is not configured.

## Public API

The package exposes an immutable, pure contract API from its root:

- `AGENT_ROLES`, `AGENT_CONTRACTS`
- `getAgentContract`, `listAgentContracts`
- `getAgentArtifactType`, `getAgentInputArtifactTypes`
- `normalizeAgentActionIntent`, `validateAgentContract`
- `ROLE_ARTIFACT_TYPES`, `ACTION_INTENT_OPERATIONS_BY_ROLE`, `ACTION_INTENT_TARGET_KINDS`, `ACTION_INTENT_TARGET_REFERENCE`

See the [public API reference](https://github.com/nplongx/runalith-agent-contracts/blob/main/API.md) for exact schemas, role vocabulary, bounds and compatibility policy. Host mirror: [`src/runtime/agent-contracts-public-api.js`](../../src/runtime/agent-contracts-public-api.js). The offline snapshot manifest pins its exact source hash and public commit.

## Boundary and compatibility adapter

[`src/runtime/workflow/agent-contracts.js`](../../src/runtime/workflow/agent-contracts.js) remains at its historical import path. It re-exports the pure API and retains `validateCompiledActionIntent(role, intent, expectedTaskId)` as a host-only compatibility adapter. The adapter preserves exact compiled task/role binding, source lineage, dependency ordering, typed input binding checks and then invokes `validateCompiledAdaptiveGoalActionIntentSemanticVerification` from [`adaptive-goal-action-intent-policy.js`](../../src/runtime/adaptive-goal-action-intent-policy.js).

The AGG semantic verifier is intentionally excluded from the public package. It checks canonical role operation/output/completion semantics, exact task/step and evidence target binding, semantic proof fields and digest. It depends on AGG-specific semantics and current compiled graph/task/evidence representation; making it a dependency of the pure vocabulary package would reverse the dependency direction and couple consumers to AGG schema evolution.

## Authority and non-goals

Role `permissions` and `allowedTools` are declarative capability vocabulary, not grants. Action-intent normalization validates shape and generic role operation allowlists; it does not establish resource binding, approval, trusted evidence, policy acceptance, dispatch authority or execution. The host remains responsible for those checks.

This extraction does not include workflow definitions/catalogs, plan compilation, custom roles, DB-backed policy stores, workflow lifecycle, trust, approval, MCP or execution. Those remain in the modular monolith until their ownership and consistency contracts are explicit.

## Compatibility

The old host module path and export names remain intact. Existing runtime and test consumers need no import migration. The package root is the only supported external import; no consumer should deep-import its source file. The package is experimental `0.x`; contract/schema changes may be breaking before `1.0.0`.
