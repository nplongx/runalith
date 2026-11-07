# WS2 Control Contract Candidate V10.24 Addendum

**Status:** `DRAFT_NOT_RATIFIED`  
**Base:** V10.23 SHA-256 `6bdf6559db853816a342b32742f1a758831359a1fdd734ca82d59c652d261b18`  
**Purpose:** respond to WS1 CR-02 request (A2A seq 1194) with source-pinned evidence and explicit blockers. This addendum does not ratify a contract or authorize shared production source changes.

## 1. Legacy `custom-task-N` labels vs stable W1 task identity

Current `runalith-store` projection helper is pinned by the exact extracted function bytes:

- Source: `rust/crates/runalith-store/src/lib.rs`
- Whole-file SHA-256 at review: `a08e43b192d02666f8b5956fa8122bd6acaf996524160c4414d5870e49ffe3e3`
- `custom_workflow_task_specs` function-slice SHA-256: `09b634dd2aadb12e359bb6c3c1f6ed81948b044e971a1fda4359f093ba17aac9`

Observed projection:

- `TaskSpec.task_id = task.task_id.clone()` preserves exact W1 compiled task identity.
- `inputs.custom_role_id` and `inputs.custom_role_version` preserve exact W1 role identity/version.
- `TaskSpec.role = format!("custom-task-{}", index + 1)` derives a positional legacy label from array order.

Therefore no valid deterministic mapping exists **from the legacy label alone** to W1 `task_id` or `role_id`. Correct identity mapping must use exact `task_id` plus explicit `custom_role_id`/`custom_role_version`; no ordinal parsing, alias lookup or array-position inference is accepted. Existing W2 candidate text already defines that distinction in `02-control-contract-candidate-v1.md` §3.10.

Important implementation gap: the positional alias is not isolated to display. Current `validate_policy_plan_compatibility` builds the role set from `task.role` (function-slice SHA-256 `e13dbacd977de1722fe4f7d693c7038393b1c674d337a1e7488b7a50e723120a`). `evaluate_persisted_success_contract` counts `task.role == role` for `task_role_present` / `task_role_absent` (function-slice SHA-256 `52e48f8d1c4350c4540afa358363d261ba2deb9c09bad48b8080a192ffcf8fba`). Thus those current legacy policy consumers see `custom-task-N`, not canonical `custom_role_id`. The alias is still semantically observable and cannot honestly be labelled display-only across the current Store path. This is a source-level blocker requiring an approved typed role projection and consumer migration.

No production Rust type named `WorkflowPlanAttachmentV1` or `WorkflowPlanTaskBindingV1` currently exists (`rg` over `rust/crates` returned no matches). The explicit separate `control_task_id` / `workflow_plan_task_id` contract is currently proposal + isolated Python oracle, not a live Rust DTO/route.

### Additional isolated evidence

New WS2 artifacts:

- `02-compiled-plan-adapter-v2.fixtures.json` SHA-256 `8bf47bc8f67c428cbe6a0d57bed43320ade5a518fa1fd9ef3a3f0917552523b2`
- `02-compiled-plan-adapter-v2-test.py` SHA-256 `d8da4407ba304a2d8aa135ca679ab8e4dddf62785d9a27f1590585bd0183b575`

Command: `python3 -B rust/workstreams/02-compiled-plan-adapter-v2-test.py` — PASS. It pins the exact W1 multi-task fixture and the Store projection/consumer function slices; validates stable mapping by exact task ID + role ID/version; rejects missing stable task ID, duplicate stable task ID, task-ID substitution with `custom-task-N`, label-only role resolution, duplicate-label resolution and renumbered-label resolution. It also proves duplicate/renumbered aliases do not change an otherwise explicit stable binding. It deliberately reports the current policy-role alias leak above.

The earlier V1 oracle remains unchanged: `02-compiled-plan-adapter-v1-test.py` SHA `c0e1cf8b15f1b30462dae446e5590d566e1762ea94e36942d3459b6c1d978456`; its run passed 2 positive + 17 negative checks. Both are isolated Python oracles. Neither executes the Rust helper, persists the proposed public attachment DTO, or proves a live Control attachment transition.

## 2. Live workflow policy attachment: implemented locally, requested transition contract incomplete

There is a real local policy attachment path:

- HTTP route: `POST /v1/workflows/{workflow_id}/policies/{policy_id}` (`runalith-control-api/src/lib.rs`, route around lines 814–837).
- API authenticates a bearer credential through host-injected `ControlPrincipalVerifier`, checks `policy.attach`, and passes authenticated `principal.subject` as `attached_by`.
- `PolicyAttachmentBody` currently contains only `version` and `base_contract` (around lines 1504–1509); it has no attachment revision, predecessor revision, request idempotency key or expected-current-revision field.
- `Store::attach_workflow_policy` (`runalith-store/src/lib.rs`, around lines 1781–1892) opens an IMMEDIATE transaction, requires an unapproved PROPOSED workflow, pins exact policy version/digest, writes immutable attachment and composed-success-contract rows, increments `workflow_success_contracts.version`, appends policy/workflow events and commits atomically.
- Event idempotency key is constructed as `policy-attach:{policy_id}:{version}`. The attachment table primary key is `(workflow_id, policy_id)`.
- A duplicate attachment is rejected before commit with `workflow policy already attached`; it does not return the original durable response/receipt. The current API has no expected predecessor/revision comparison. The local contract version is a counter, not a caller-bound revision transition.

Tested command:

`cargo test --manifest-path rust/Cargo.toml -p runalith-store --locked --offline workflow_policy_versions_attach_exactly_and_pin_composed_contract_at_approval -- --nocapture`

PASS: 1 targeted test. It proves exact immutable policy version pinning and duplicate rejection, not same-key idempotent replay or predecessor/revision CAS semantics.

Disposition for CR-02: **PARTIAL / BLOCKING**. A future approved successor needs caller-owned idempotency key + canonical request digest, expected predecessor/current revision, durable revision receipt, same-key/same-body replay returning original receipt, same-key/changed-body conflict, and event/projection ordering under one authoritative transaction.

## 3. Authenticated `ExecutionManager` identity: evaluator guard exists, producer/source is not wired

Observed domain contract:

- `PolicyTaskContextV1` has `executor: Option<String>`.
- `From<&CompiledWorkflowPlan>` deliberately sets `executor: None` with comment that a compiled plan does not attest executor identity and must not infer `ExecutionManager` from `deterministic=true` (`runalith-domain/src/workflow_policy_v1.rs`, around lines 109–147).
- `execution_exit_code_equals` requires both `deterministic` and `executor == Some("ExecutionManager")` (around lines 775–790).
- Existing unit test directly mutates the in-memory test context to set `executor=Some("ExecutionManager")`; it does not authenticate that value or exercise a producer/receipt path.
- Store success evaluation explicitly returns `UNRESOLVED` for `execution_exit_code_equals` because authoritative execution exit-code evidence is absent from the Control evidence model (`runalith-store/src/lib.rs`, around lines 9806–9816; seed policy text around line 1651 says the same).

The standalone Control host does authenticate API bearer tokens from its owner-only auth file and derives `ControlPrincipal {subject, issuer, capabilities}`; however `PolicyTaskContextV1` never consumes that principal or a worker receipt. The standalone `runalith-control serve` composition still installs `DenyWorker`, `DenyResultProducer`, `DenyCancellation`, `deny_all_approval_verifier` and `DenyTrustedSkills` (`runalith-control-api/src/main.rs`, around lines 745–759). No authenticated `ExecutionManager` identity producer is connected to success-contract evaluation.

Targeted tests:

- `cargo test --manifest-path rust/Cargo.toml -p runalith-domain --locked --offline execution_exit_code_predicate_requires_attested_executor_identity -- --nocapture` — PASS, 1 test; guard only.
- `cargo test --manifest-path rust/Cargo.toml -p runalith-control-api --locked --offline principal_file_authenticates_hash_only_tokens_and_returns_file_capabilities -- --nocapture` — PASS, 1 test; bearer principal mapping only, not executor identity binding.

Disposition for CR-02: **NOT WIRED / NOT PROVEN**. Need an approved producer-owned Execution identity/receipt with issuer, subject, audience, workflow/task/attempt binding, expiry/revocation and replay protection; Control must verify it before populating `PolicyTaskContextV1.executor`. Never derive it from plan metadata, deterministic flag, role label or caller-supplied JSON.

## 4. Ownership and change boundary

WS2 implementation ownership remains `UNASSIGNED`. The eight-part plan authorizes documentation and isolated fixtures/tests only; it does not authorize source, schema, database, service, deployment, migration or cutover changes. The policy alias consumer migration, versioned attachment protocol and executor identity verifier cannot be implemented by WS2 without Project Owner assigning accountable owners, exact module/worktree boundaries and authority decisions. Host Security / Execution must own the trusted executor identity producer; WS2 owns its Control-side verification/consumption once approved.

## 5. WS1 CR-02 response

- Legacy plan task ID mapping: deterministic only through exact `task_id` plus explicit role metadata; `custom-task-N` cannot resolve either stable identity. New V2 oracle adds requested missing/duplicate/renumber negatives, but exposes current legacy role-policy consumer gap.
- Live policy attachment: local immutable attach exists and passes its targeted test; requested revision/predecessor/idempotent replay semantics are absent.
- Trusted executor identity: domain guard exists but no trusted producer-to-Control path; Store returns `UNRESOLVED`.
- Overall CR-02: **CHANGES_REQUESTED / BLOCKING remains appropriate**. No runtime successor closes it. Owners required: Project Owner to assign WS2; Execution/Host Security for trusted identity authority; WS2 after authorization for attachment/consumer protocol.

No production Rust/Node source, schema, database or deployment file was changed. No commit or push was made. New V2 fixture/test and this addendum are WS2-owned untracked evidence only; they are not included in the frozen WS8 R5.4.2 archive.
