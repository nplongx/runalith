# Adaptive Goal reviewer-attestation ingestion

RC.68 adds the missing runtime ingestion boundary for the existing provider-signed reviewer identity contract. Before this addition, the verifier and dispatch guards could validate a durable `adaptive_goal.action_intent_review_authorized` event, but there was no runtime API that accepted, verified, and persisted that assertion; tests inserted it directly into SQLite.

## Contract and lifecycle

`adaptive_goal_reviewer_attestation_ingest` accepts `job_id` plus an Ed25519 attestation issued by the independently configured action-review identity provider. The provider—not the MCP caller or Runalith—must authenticate the human reviewer and authorize `agg.action_intent.review` before signing. Runalith never creates, repairs, or re-signs an attestation.

While holding the workflow database `BEGIN IMMEDIATE` writer transaction, ingestion rebuilds the exact persisted candidate and requires a fresh, trusted Goal/Idea source snapshot with a resolvable evidence manifest. It binds the signed assertion to the wrapper job, candidate ID/fingerprint/hash, immutable compiler plan hash, reviewed action-intent hash, reviewed task-input contract hash, semantic policy version/hash, and role-contract hash. It then delegates signature, reviewer subject, trust-root/revocation, scope, issuance/expiry, nonce, and anti-rollback checks to the same verifier used by the approval and dispatch paths. The record is committed only after exact event persistence and a second current-candidate readback succeeds.

The first ingestion is allowed only while the candidate wrapper is unapproved, unpinned and undispatched with no task rows. An exact retry may read back the already verified event idempotently; a different payload, duplicate event, reused nonce, stale source snapshot, invalid signature, changed candidate, or advanced lifecycle fails closed. Failed verification rolls back the workflow event. Ingestion does not approve a workflow, pin an execution plan, create tasks, dispatch work, or grant execution authority.

## Trust and operational limits

The reviewer trust root and its anti-rollback ledger must be configured by the authorized host/security administrator. Reviewer and Goal/Idea verifier trust domains must remain independently administered and disjoint. A valid local signature or fixture key proves only that the test exercised the verifier; it is not production identity evidence. This runtime boundary verifies a provider's signed assertion but cannot independently prove the provider's human-authentication process. The provider integration and its authorization controls remain an external trust dependency.

This contract does not infer a quorum threshold, requester/maker identity, or maker-checker rule from reviewer identity. RC.71 adds the separate [versioned Approval Subsystem](adaptive-goal-approval-subsystem.md), which requires authority-signed policy, maker attestation, and checker decisions with an explicitly defined quorum and exact plan/action/evidence binding. The authoritative policy owner and independent identity providers must still supply the real policy and authenticated signers. The existing workflow approval record is not itself a replacement for these signed assertions or final dispatcher verification.

The rollout remains **BLOCKED** until the existing six production gates are closed with current, independently verified evidence: the frozen Phase 2 71-path contract, independent release evidence, production AGG trust configuration, external trust-ledger anchor continuity, active workflow drain, and running-task drain. This change does not activate the package or perform live approval, dispatch, trust-ledger operations, workflow mutation, or external checkpoint transition.

## Validation coverage

The isolated reviewer-identity regression suite checks valid signed ingestion, exact readback/idempotent retry, invalid-signature rollback, candidate/plan mismatch rollback, cross-job nonce replay, expired source snapshot, and refusal after the approval lifecycle has advanced. Extracted-package schema validation checks the public tool contract. These tests validate implementation behavior only; they do not grant production trust or release authority.
