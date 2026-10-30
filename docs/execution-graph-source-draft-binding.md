# Execution Graph source Plan Graph draft binding (RC.70)

## Why the binding is part of the proposal contract

The previous Execution Graph proposal verifier checked the deterministic formula for `sourceStepId` and `node.id`. Those checks rejected a simple `sourceNodeId` mutation when the corresponding IDs were left unchanged, but did not establish that a fully re-hashed node/step/binding identity was present in the original Plan Graph draft. A serialized proposal could therefore be internally self-consistent while naming a source node that was never in its Plan Graph draft.

## Contract change

Execution Graph proposal contract version 2 includes `source.planGraphDraftSnapshot`, the canonical serialized Plan Graph draft used to build the proposal. Verification requires:

- the snapshot's `draftHash` to equal the source's pinned `draftHash` and recompute from the snapshot body;
- its graph hash and selected candidate ID to equal the source fields in the Execution Graph proposal;
- every source Plan Graph step ID to be unique and to equal the deterministic identity derived from its original `sourceNodeId`;
- a one-to-one mapping between source draft steps and Execution Graph nodes;
- each Execution Graph node's `sourceNodeId`, kind, title, and dependencies to match the corresponding source draft step;
- the existing role/task bindings, edge table, evidence snapshots, component hashes, fingerprint, and outer proposal hash to continue validating.

The v2 schema intentionally rejects prior serialized v1 Execution Graph proposals, which do not carry the source-draft body. Durable runtime readback must rebuild a current proposal from the independently revalidated Plan Graph source before downstream candidate preparation, approval, plan pinning, or dispatch. Old records are preserved as historical evidence but must not be silently upgraded or treated as current.

## Security boundary and limitation

This body/hash check is structural integrity, not an authentication primitive: a caller-controlled, unkeyed payload and its hashes cannot prove human identity, Goal/Idea signature authenticity, trust-root validity, or source freshness. The source draft snapshot must come from the current Plan Graph producer, whose source Goal/Idea snapshot and evidence are revalidated under the configured authority. The runtime readback continues to independently rebuild the Execution Graph proposal and compare it with the persisted record before it can be consumed. Approval and dispatch must still independently verify the current approval, policy, plan pin, and evidence.

## Regression

The negative regression changes `sourceNodeId`, recomputes the deterministic `sourceStepId` and node ID, rewrites the binding IDs and dependency references, and recalculates the exposed component hashes, fingerprint, proposal ID, and outer hash. Contract v2 rejects the proposal because the rewritten node no longer maps to the original source Plan Graph draft. Existing simple-mutation tests remain in place. A green isolated regression or local hash is not production authority.
