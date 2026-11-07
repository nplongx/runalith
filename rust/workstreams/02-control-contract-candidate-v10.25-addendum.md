# WS2 Control Contract Candidate V10.25 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.24 SHA-256 `486eded28425084d5834cf5b88e97e08453699ed570eda5d2c966ff6e3fc5ea5`  
**Purpose:** answer WS1 CR-02 source-boundary review (A2A seq1243/1244) with exact bounded disposition and Node runtime evidence. No runtime contract is ratified by this addendum.

## 1. WS1 accepted scope — typed plan mapping fixture only

WS1's exact disposition for V1 is:

`ACCEPTED_WITH_BLOCKERS_FOR_TYPED_PLAN_ATTACHMENT_MAPPING; DRAFT_NOT_RATIFIED`

Exact accepted candidate V1 doc SHA `86365876b2677ce9f99aeb23df0a1b49bcaaeb271f744731883740002f3ceec5`; fixture SHA `fc98f572d25dee44661a5f84ad5566e1eacca57881ca8c8b1bbc974175c8a048`; validator SHA `c0e1cf8b15f1b30462dae446e5590d566e1762ea94e36942d3459b6c1d978456`. Both WS1 and WS2 executed `python3 -B rust/workstreams/02-compiled-plan-adapter-v1-test.py`: PASS 2 positive +17 negative checks.

Accepted scope is fixture-only: outer plan digest pin; exact workflow identity/version; complete one-to-one explicit Control task ID to W1 `workflow_plan_task_id` mapping; stable ID/order/role-version/dependency/typed-I/O equality; rejection of duplicate/missing/unknown/positional `custom-task-N` aliases. It is not runtime adapter or contract ratification.

## 2. Legacy Node custom-workflow compiler — locally implemented, not public W1 adapter

WS1 source hashes independently match the current main worktree:

- `src/runtime/workflow/compiler.js`: `5784fa0e3b75b6c38857e66f4ddfd99233d0ec8dd2fa0e69fae01d6dbc4decf9`
- `src/runtime/workflow-state-port.js`: `56100713342ec834f20f0806550559bf0dbfe563c2464d78cb9aeff0a7f5da52`
- `src/runtime/workflow/policy-contract.js`: `cccb834047d97fbd1f36741a6b466baf03e83e9a480402e5d85a283ada921b89`
- `src/runtime/execution-manager.js`: `327f3a36a7c6baa0769f18d7284b95b53b7f5c3eaae25ca9fa03a0d9e599b8c0`

Current `compileWorkflowPlan` behavior (`compiler.js`, custom workflow branch):

- `child.id` is copied from legacy custom-plan `task.id`.
- `child.execution.custom_role_id` and `custom_role_version` preserve the immutable custom role reference.
- `child.role` is synthesized as `custom-task-${index + 1}`.
- Dependencies retain legacy custom-plan task IDs.

`assertImmutablePlannedExecution` (`workflow-state-port.js`) requires `metadata.workflow_plan_task_id`, resolves exact child ID, and checks role/dependency equality against the immutable local plan before execution. This establishes a local legacy plan binding, not a frozen public adapter mapping legacy IDs to W1 `CompiledPlanV1` identities. The plan does not prove cross-service ID authority or W1 outer-plan revision binding.

New isolated runtime test:

- `02-legacy-node-custom-workflow-adapter-v1.fixtures.json` SHA `71536215f07acc27f6d02f44404beeb8ba71cf3c2948c92ca8111814425b8a76`
- `02-legacy-node-custom-workflow-adapter-v1-test.mjs` SHA `b7d35568e86c9e22f7e5ba0226192c1b61d2a541890ad8d5627ebc5b1392ffa0`
- Command: `node rust/workstreams/02-legacy-node-custom-workflow-adapter-v1-test.mjs` — PASS.

It pins compiler, state-port and policy-consumer source hashes; imports and executes actual `compileWorkflowPlan`; verifies child IDs, role IDs/versions and dependencies; proves reordering preserves ID/role metadata pairs but renumbers `custom-task-N`; rejects missing and duplicate child IDs. Scope is exactly local Node compiler behavior. It does not claim public W1 adapter acceptance.

Additional source-level issue: Node `assertPredicateCompatible` derives role predicates from `child.role`. Rust Store's `validate_policy_plan_compatibility` and `evaluate_persisted_success_contract` likewise consume `TaskSpec.role`. Because custom workflow compiler writes positional `custom-task-N` there, current policy role predicates observe the alias, not `custom_role_id`. The alias is not globally display-only; consumer migration/typed role identity remains a source-level blocker. WS2 Rust-side pinned oracle `02-compiled-plan-adapter-v2-test.py` PASSes six negatives and captures this gap; V2 fixture SHA `8bf47bc8f67c428cbe6a0d57bed43320ade5a518fa1fd9ef3a3f0917552523b2`, validator SHA `d8da4407ba304a2d8aa135ca679ab8e4dddf62785d9a27f1590585bd0183b575`.

## 3. Live policy attachment — locally implemented; requested revision event remains blocking

Node `attachWorkflowPolicy` (`policy-contract.js`) runs in a DB savepoint, requires active unapproved proposal, rejects after approval/plan compilation, rejects duplicate policy, persists immutable policy attachment and events. `node tests/test-policy-contract.js` PASS. Existing test covers exact attachment, duplicate rejection, and rejection after approval; it does not cover caller idempotency/replay receipts or outer plan revision CAS.

Rust `Store::attach_workflow_policy` runs an IMMEDIATE transaction, pins exact immutable policy version/digest, creates a composed success-contract version, appends ledger/events, and commits atomically. `cargo test --manifest-path rust/Cargo.toml -p runalith-store --locked --offline workflow_policy_versions_attach_exactly_and_pin_composed_contract_at_approval -- --nocapture` PASS, 1 targeted test. Duplicate attachment is rejected; no prior durable receipt is returned.

Current Node and Rust implementations are local pre-approval attachment mechanics. Neither implements the requested cross-part `WorkflowPolicyAttachmentEventV1` that binds a new W1 outer plan revision and caller-owned event identity. Missing fields/semantics: caller idempotency/event ID, canonical request digest, expected prior journal sequence/head or revision CAS, same-key/same-body replay returning original durable receipt, same-key/changed-body conflict. Existing attachment row/event is not that contract.

Disposition: `PARTIAL_IMPLEMENTED_LOCALLY; CROSS_PART_REVISION_CAS_IDEMPOTENCY_NOT_IMPLEMENTED_NOT_PROVEN`.

## 4. ExecutionManager authentication — guard exists; trusted identity producer is not wired

Node `compileWorkflowPlan` stores `executor: ExecutionManager` in deterministic plan metadata. Node `ExecutionManager` checks that exact immutable plan metadata and `assertImmutablePlannedExecution` revalidates plan hash/command before execution. Those are plan-authorization checks, not authenticated process identity.

Rust domain `execution_exit_code_equals` similarly requires a deterministic task and `executor == ExecutionManager`; its test manually injects that context. `PolicyTaskContextV1::from(CompiledWorkflowPlan)` intentionally starts executor as `None`. Rust Store returns `UNRESOLVED` for execution exit-code policy because it lacks authoritative durable execution evidence. The host's bearer authenticator maps hashed bearer credentials to `ControlPrincipal`, but that principal is not connected to the policy execution context or a verified ExecutionManager receipt. Standalone `runalith-control serve` wires `DenyWorker`, `DenyResultProducer`, `DenyCancellation`, deny-all approval, and `DenyTrustedSkills`.

Targeted test:

`cargo test --manifest-path rust/Cargo.toml -p runalith-domain --locked --offline execution_exit_code_predicate_requires_attested_executor_identity -- --nocapture` — PASS, 1 test; it proves the evaluator guard only.

`cargo test --manifest-path rust/Cargo.toml -p runalith-control-api --locked --offline principal_file_authenticates_hash_only_tokens_and_returns_file_capabilities -- --nocapture` — PASS, 1 test; it proves bearer-to-principal mapping only, not ExecutionManager identity.

Disposition: `NOT_WIRED_NOT_PROVEN`. Need Host Security/Execution-owned identity issuer and durable attempt receipt bound to issuer, subject, audience, workflow, task, attempt, expiry/revocation and replay protection. Control must verify it before setting executor context. Never derive trusted identity from plan metadata or caller-supplied JSON.

## 5. Test environment note

`node tests/test-policy-contract.js` passed. `node tests/test-execution-plan-binding.js`, `node tests/test-workflow-plan-m2.js`, and `node tests/test-workflow-plan-structural-contract.js` failed before assertions during `src/runtime/job-store.js` SQLite initialization with `ERR_SQLITE_ERROR: disk I/O error`. Root filesystem was 99% used with 5.6 GB available at inspection. These runs are not counted as passes; the direct compiler test above avoids global SQLite initialization.

## 6. CR-02 disposition and owner actions

| Sub-item | Evidence status | Disposition |
|---|---|---|
| Typed Control-task to W1 plan-task mapping fixture | WS1 accepted exact V1 fixture/test; 2 positive +17 negative | `ACCEPTED_WITH_BLOCKERS_FOR_TYPED_PLAN_ATTACHMENT_MAPPING; DRAFT_NOT_RATIFIED` |
| Legacy Node compiler behavior | Actual compiler runtime test PASS; local child ID/role metadata binding exists | `IMPLEMENTED_LOCALLY; PUBLIC_W1_ADAPTER_NOT_FROZEN_NOT_ACCEPTED` |
| Policy attachment mechanics | Node savepoint and Rust IMMEDIATE transaction tested | `IMPLEMENTED_LOCALLY; CROSS_PART_REVISION_CAS_IDEMPOTENCY_BLOCKING` |
| Authenticated ExecutionManager identity source | Plan metadata guard only; no trusted producer/receipt wired | `NOT_WIRED_NOT_PROVEN; BLOCKING` |
| Overall CR-02 | Three separate unresolved runtime contract/source boundaries remain | `OPEN_BLOCKING; CHANGES_REQUESTED` |

WS2 implementation owner remains `UNASSIGNED`. Project Owner must assign accountable WS2 owner and approve exact source/module/worktree boundaries before production implementation. Host Security/Execution must own the trusted ExecutionManager identity issuer and receipt. WS2 can own Control-side verifier/consumer after authorization. Eight-part plan currently permits documentation/isolated fixtures only; this addendum makes no production source, schema, DB, service or deployment edits.

No commit or push. New fixture/test/addendum are WS2-owned untracked evidence. R5.4.2 package evidence is separately verified and does not imply contract ratification or release readiness.
