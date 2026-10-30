# Adaptive Goal Execution Approval Subsystem — versioned contract

## Purpose and security boundary

RC.71 adds a distinct, versioned Approval Subsystem between the review-only Plan/Execution Graph proposal and the existing durable workflow approval. A reviewer identity assertion is evidence that a particular identity provider authenticated a reviewer and issued a scoped assertion; it is not itself approval. The existing generic `workflow_approve` host label and a confirmation string are not maker/checker or quorum evidence.

An AGG Execution Graph wrapper can be approved only when the runtime independently verifies a signed approval policy, a separately signed maker/requester attestation, and policy-compliant checker decisions. The approvals are persisted as an immutable binding in the `approval.approved` event inside the same workflow writer transaction that pins the immutable execution plan. Dispatch and every AGG execution path must revalidate the policy, all signed decisions, current trust/revocation, high-water policy version, exact evidence and plan binding immediately before task claim/spawn or workspace mutation. The public preflight can verify evidence but never approves or advances workflow state.

## Version 1 signed envelopes

Three independently administered, host-managed trust domains sign different contracts:

| Domain | Scope | Signed object | Function |
|---|---|---|---|
| `execution_approval_policy` | `agg.approval.policy` | `adaptive_goal_execution_approval_policy` | Reusable versioned policy: reviewer registry, required approval count, required roles, minimum distinct trust domains, veto, maker/checker separation and maximum vote age. |
| `action_intent_maker` | `agg.action_intent.propose` | `adaptive_goal_action_intent_maker_attestation` | Identifies the authenticated requester/maker and binds that identity to the named signed policy version and the exact candidate/action/plan/evidence/scope. |
| `execution_approval` | `agg.execution.approve` | `adaptive_goal_execution_approval_decision` | One authenticated approve/reject vote, tied to a listed reviewer/role/trust domain and the exact policy and candidate binding. |

Every envelope uses Ed25519 and contains a version, provider ID, trusted-root fingerprint, nonce, issue/expiry times, scope, and signature. The signed policy defines the quorum; the runtime has no default quorum. Policy versions are reusable across proposals. Maker attestation and checker votes—not the reusable policy document—bind to the exact current wrapper proposal hash, candidate ID/fingerprint/hash, immutable compiler plan hash, source snapshot and evidence manifest hashes, action-intent hash, reviewed task-input contract, current evidence hashes and a hash of the compiled permission/role/operation/workspace-write scope.

The signed reviewer registry maps a unique authenticated subject to role, trust domain and a currently configured signing root. A policy is rejected if it is internally unable to meet its own count/domain/role requirements, reuses checker identities or roots, fails maker/checker separation, or has an invalid time window. The configured trust-domain provider IDs and roots must also be pairwise disjoint from the Goal/Idea verifier, reviewer identity, policy, maker and checker trust domains. Policy-signing roots are not approval votes and do not implicitly authorize an approval.

## Persistence, replay, expiry and concurrency

`workflow_approve` verifies the submitted evidence while `JobStore` holds the workflow database `BEGIN IMMEDIATE` writer transaction. It stores the original signed evidence plus its verified binding and hash in the exact `approval.approved` event while pinning the immutable plan. Retries must submit exactly the same signed evidence and reproduce the original binding; replacing a vote or policy cannot silently reapprove an existing workflow. Duplicate or conflicting current approval events fail closed.

Each policy, maker assertion and checker vote must have a distinct canonical UUID nonce. Replay checks scan prior durable approval records and fail closed if prior approval evidence is malformed or ambiguous. Policy high-water events are written only in the approval transaction after the host-managed trust configuration has already been explicitly observed. Equal policy version/hash is idempotent; lower versions and reusing a version for a different hash are rejected. This workflow event high-water prevents local replay/downgrade within the observed store; it is not a production external trust ledger or independent monotonic checkpoint.

Expiry and revocation are rechecked at preflight, approval retry, dispatcher entry, batch execution, local task execution and immediately before the supported AGG workspace-write mutation. If policy, maker, any required vote, trust root, evidence or immutable plan can no longer be verified, the operation fails closed. No task spawn or AGG workspace write is authorized by a previously valid approval after its time window or trust state has changed.

## Host-managed configuration

The package exposes three additional optional host configuration inputs:

- `approval_policy_trust_config_json` → `AGG_APPROVAL_POLICY_TRUST_CONFIG_JSON`
- `action_intent_maker_trust_config_json` → `AGG_ACTION_INTENT_MAKER_TRUST_CONFIG_JSON`
- `execution_approval_trust_config_json` → `AGG_EXECUTION_APPROVAL_TRUST_CONFIG_JSON`

Their default value is blank. The authorization/security administrators must provision current, versioned JSON trust configurations with public Ed25519 roots and the exact scopes above, then use the explicit trust-configuration status operation to observe/configure the versions in the host-managed high-water ledger. Approval, preflight and dispatch never auto-provision these trust roots. Private keys must remain with their external authority; the plugin takes signed envelopes, not private key material.

The external identity and approval providers must authenticate the actual human identities before signing. A locally generated test key, signed fixture, locally stored high-water event, hash, or green test does not prove production identity, authority, independent release provenance, or external checkpoint continuity. An authority owner must provide and approve the policy's actual requester/maker separation, checker roster, quorum, roles and trust-domain constraints; the runtime does not infer those decisions.

## Test coverage and release limitations

The isolated tests cover missing/unobserved trust configuration, provider/root separation, altered signatures, altered plan/action/evidence bindings, maker/checker identity reuse, insufficient quorum and trust domains, required roles, expired and revoked keys, nonce replay, policy-version reuse/rollback, concurrent/idempotent transaction behavior, persistence/recovery and preflight/approval/dispatch revalidation through the three-graph E2E. The E2E uses test-only keys in a disposable database.

RC.71 rollout remains **BLOCKED** until the six production release gates are closed with current, independent authority evidence: the frozen Phase 2 71-path contract; independent release evidence; production AGG trust configuration; external checkpoint continuity; active workflow drain; and running-task drain. A passing test or a signed test fixture closes none of these gates.
