# Workstream 4 — Provider Effects & Reconciliation

**Deployable:** Execution Workers. **Status:** contract v1 draft implemented in the W4 provider crate; consumer integration and accountable owner remain unassigned. See the [master eight-part plan](../EIGHT_PART_PARALLEL_PLAN.md).

## Mandate

Own external provider side effects and evidence of what the provider accepted, rejected or left ambiguous.

## Ownership

- Provider adapters and their credential/configuration contracts.
- Immutable request payload bytes/digests, dispatch intents and idempotency keys.
- Provider run identity, send/accept/reject/unknown state machine, polling and lookup.
- Provider observations, terminal proof, duplicate-send prevention and reconciliation journal.

## Explicit non-ownership

No Control task/lease/workflow state or lease settlement; no local process supervisor; no session delivery/artifact byte store; no approval, trust root or AGG evidence decision.

## Current code map

`runalith-providers/src/contract_v1.rs` defines the versioned dispatch request, effect subject, observation, provider run reference, terminal proof, and Governance verifier port. `runalith-providers/src/github_actions.rs` implements the v1 adapter port and requires an explicit non-secret account identity (`GITHUB_ACTIONS_ACCOUNT_ID` for the environment constructor, or `with_executor_for_account`). An absent/mismatched account identity fails before provider I/O.

`ProviderControlFenceV1` now carries the exact W3 reservation result: `fence_id`, claim/lease/worker/owner epoch/plan, `side_effect_id`, `provider_dispatch` kind, the full legacy `ProviderDispatchRequest` digest, the distinct `worker-fence:…` idempotency key, `acl_sha256`, `RESERVED` state and canonical Control receipt digest. It recomputes the W3 idempotency formula and `ProviderDispatchRequestV1::from_intent` rejects a fence that does not bind the exact immutable intent. W3 must construct it only after checking the persisted `ExecutionFenceRequest` against the `ExecutionFence` response and authenticating the Control receipt; W4 does not replace that authority check.

`ProviderDispatchObservationV1::to_persistence_response` serializes the complete versioned observation, including the Control fence, claim/owner-epoch/account binding, into the existing append-only `ProviderReconciliationObservation.response` field. This is a compatibility encoding only: it does not change Store schema v20, move database ownership, or make the legacy SQL participant a cross-deployable store. The existing Node `execution-persistence-store.js` remains a read-only parity oracle.

## Public outputs

`ProviderDispatchRequestV1`, `ProviderDispatchObservationV1`, `ProviderRunRefV1` and `ProviderTerminalProofV1` with explicit `NOT_SENT`, `ACCEPTED`, `REJECTED` and `UNKNOWN` semantics. Every request/observation/proof is bound to workflow/task/claim/attempt/owner epoch/lease/worker, the exact Control fence (including ACL and receipt digest), provider account/idempotency key, plan digest and payload digest. Dispatch payload bytes and terminal provider response bytes are SHA-256 pinned. For W5 handoff, `response_bytes`, `response_sha256`, `media_type` and the subject's `producer_id`/workflow/task/attempt/correlation/observed time provide the inputs to `ArtifactStore::put` + `ArtifactRefV1` (`contract_version=1.0`, `artifact_id=sha256:<digest>`, byte length, media type, and matching `ArtifactSourceV1`). W5 owns the durable artifact and manifest; W4 does not create a trust decision. `ProviderTerminalProofVerifier` is an injected Governance port; this crate provides no permissive verifier and does not claim that provider TLS alone is a signed Governance receipt.

W6's 2026-11-03 authority-boundary review confirms no existing public `ProviderTerminalProofV1` or Governance verifier protocol contract was found. W6 does not consider an unsigned provider API response alone sufficient to establish trusted terminality. A provider-native authenticated proof may be considered only when W4 demonstrates independently checkable provider identity, exact full-subject binding and replay protection; whether Control must additionally issue a signed receipt remains unresolved. The current V1 receipt envelope is therefore a port shape only, not a production trust decision or approved receipt contract.

**Consumes:** Control claim/idempotency identity (workstream 2), supervisor lifecycle (workstream 3), artifact collection (workstream 5), Governance verification contracts (workstream 6).

## Parallel development

Provider-specific contract fixtures; exact payload digest; reserve-before-send; poll/status lookup; timeout-after-send; replay, duplicate and failure injection using fake providers. No live provider dispatch during this workstream's local testing unless separately authorized.

## Acceptance

1. One external dispatch per idempotency identity; changed request under same key conflicts.
2. Timeout/connection loss after send remains UNKNOWN, never assumed NOT_SENT.
3. Exact run/account/claim/attempt/owner-epoch binding; signed/verifiable terminal proof.
4. Late and reordered provider observations cannot rewrite Control lifecycle or release leases.
5. Crash/restart and reconciliation never repeat an ambiguous external effect.

## Ownership record — fill before coding

| Field | Value |
|---|---|
| Accountable owner | UNASSIGNED |
| Branch/worktree | Existing shared checkout on `main`; no isolated W4 worktree was created because this repository already contains parallel uncommitted work. |
| Exact files/crates | `runalith-providers/Cargo.toml`, `src/lib.rs`, new `src/contract_v1.rs`, `src/github_actions.rs`; no W2/W3/Store schema files changed. |
| Contract version | Draft `ProviderDispatchRequestV1` / `ProviderDispatchObservationV1` / `ProviderRunRefV1` / `ProviderTerminalProofV1` (v1); pending W2/W3/W5/W6 review. |
| Consumer reviewers | Workstreams 2, 3, 5, 6, 8 owners |
| Acceptance commands/evidence | `cargo test -p runalith-providers -p runalith-execution-persistence --locked --offline -- --test-threads=1` (providers 28/28; persistence 7/7); `cargo clippy -p runalith-providers -p runalith-execution-persistence --all-targets --locked --offline -- -D warnings` (PASS). |

Workspace cross-check: `cargo test --workspace --no-run --locked --offline` builds every workspace test executable (PASS). The full `cargo test --workspace --locked --offline -- --test-threads=1` currently stops while compiling `runalith-domain` tests because the two `include_str!` fixtures `tests/fixtures/node-workflow-policy-v1.json` and `tests/fixtures/node-workflow-policy-composition-v1.json` are absent; no synthetic fixtures were added. W4's targeted tests and Clippy remain green independently of that out-of-scope fixture issue.

## Integration gates still open

- W2 must confirm the canonical Control claim/reservation fields and which service owns lifecycle settlement.
- W3 must map its journaled `ExecutionFenceRequest` plus the validated `ExecutionFence` response to `ProviderControlFenceV1` and pin a stable `provider_account_id` in its durable provider intent/host configuration. The W3 journal currently carries the reservation request/owner epoch but no explicit provider-account reference; account selection must not silently drift on restart. This change deliberately does not edit W3-owned files or wire a second dispatch path.
- W5 must ratify the proposed `ArtifactStore::put` → `ArtifactRefV1` source-lineage mapping; W4 only returns bounded proof material and never owns artifact storage or manifests.
- W6 must publish the signed receipt/key/freshness/revocation contract consumed by `ProviderTerminalProofVerifier`, or explicitly ratify the independently checkable provider-proof model plus its replay-protection requirements. W4's current configured account reference and raw API response are not claimed to satisfy that trust decision; no local/test verifier is promoted to production.
- The durable legacy provider intent row still lacks first-class owner-epoch/account columns. The v1 observation can be appended without a schema change, but v1 dispatch-intent durability and DB ownership extraction remain gated on the D-01/ADR 0003 authority decision and consumer-owner approval.
- No live provider dispatch was performed. No Control lifecycle rows, W3 worker journal, Store schema migration, DB split, or cutover was changed.
