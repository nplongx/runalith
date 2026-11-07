# Workstream 7 — AGG Evidence & Checkpoint Custody

**Deployable:** Governance & Interface. **Status:** proposed boundary; owner unassigned. See the [master eight-part plan](../EIGHT_PART_PARALLEL_PLAN.md).

## Mandate

Build/verify evidence and knowledge graphs, maintain checkpoint continuity and produce review-only planning proposals. Never create workflow execution authority.

## Ownership

- AGG graph revisions, memberships/edges, source snapshots and evidence manifests.
- Producer/artifact provenance and exact source-byte lineage resolution.
- Candidate search/ranking and review-only Plan Graph/Execution Graph proposals.
- Source-verification request/receipt composition and checkpoint operation journal/external anchor/status/head continuity.
- Quarantine, attestation evidence assembly and restore/fork lineage checks.

## Explicit non-ownership

No canonical trust/reviewer roots or signing key; no approval decision; no workflow/task/lease lifecycle; no process/provider facts; no artifact-byte store; no Gateway capabilities.

## Current code map

`runalith-agg`; verifier/receipt contracts shared with `runalith-trust` only by public interface; Node AGG stores/verifier/benchmark fixtures; `docs/agg-external-checkpoint-v2-decision-register-20261030.md`; `docs/rust-part3-governance-interface-contracts.md`.

## Public outputs

`EvidenceSnapshotV1`, `EvidenceManifestV1`, `ProducerLineageV1`, `SourceVerificationRequestV1`, `SourceVerificationReceiptV1`, `CheckpointOperationV1`, `CheckpointHeadV1` and review-only graph proposals. A local manifest/digest is not a verifier signature; VERIFIED requires independent authority over exact source bytes and lineage.

**Consumes:** `ArtifactRefV1`/lineage from workstream 5; trust, verifier and signer contracts from workstream 6; read-only workflow/candidate/plan references from workstreams 1–2.

## Parallel development

Pure schema/canonical digest vectors; manifest generation; deterministic graph algorithms; benchmark reproduction; checkpoint saga state-machine tests against fake authority. No checkpoint advance, attestation signing or production provenance repin without named owner authorization.

## Acceptance

1. Exact source bytes, content hash, producer/attempt lineage and manifest binding.
2. Missing/stale/ambiguous evidence remains UNKNOWN; no synthetic VERIFIED status.
3. Independent signature/nonce/replay/expiry checks; monotonic checkpoint and predecessor continuity.
4. Crash/retry/restore/fork tests; complete reader/writer inventory and owner-approved global writer barrier.
5. AGG proposals remain review-only and cannot trigger dispatch, approval or lease settlement.

## Ownership record — fill before coding

| Field | Value |
|---|---|
| Accountable owner | UNASSIGNED |
| Branch/worktree | TBD |
| Exact files/crates | TBD; keep trust signer owned by workstream 6 |
| Contract version | Draft evidence/checkpoint v1 (v2 external spec remains normative) |
| Consumer reviewers | Workstreams 2, 5, 6, 8 owners |
| Acceptance commands/evidence | TBD |
