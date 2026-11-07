# Workstream 3 — Worker Runtime & Sandbox

**Deployable:** Execution Workers. **Status:** proposed boundary; owner unassigned. See the [master eight-part plan](../EIGHT_PART_PARALLEL_PLAN.md).

## Mandate

Execute an already-authorized claim within its exact command, workspace and resource scope. Report local process facts; never decide workflow lifecycle or infer remote provider terminality.

## Ownership

- Worker admission and claim signature/audience/subject/expiry verification.
- Process supervisor, start/wait/stop, timeout, process-tree and local crash lifecycle.
- Sandbox namespace/mount/environment/resource policy, per-claim workspace and host quota integration.
- Local stdout/stderr/exit/resource observations, worker health and service lifecycle.

## Explicit non-ownership

No workflow/task/lease mutation or claim issuance; no provider truth; no session ACL/delivery; no artifact trust; no Governance keys; no recovery disposition.

## Current code map

`runalith-worker` composition root, `runalith-execution`, `runalith-sandbox`, `runalith-linux-quota` and `deploy/worker`. Worker composition includes workstreams 4 and 5 through public ports; do not absorb their private stores. Quota helper remains host-security infrastructure, not a separate application deployable.

## Public outputs

`WorkerClaimAcceptedV1`, `ProcessObservationV1`, `ProcessStopReceiptV1`, `WorkerHealthV1` and execution diagnostics. A local process-stop receipt must explicitly **not** claim provider-side no-more-effects proof.

**Consumes:** Control `TaskClaimV1` and exact `CommandRequestV1` from workstream 2; provider/session/artifact ports from workstreams 4–5; host configuration and credentials provisioned by operators.

## Parallel development

Process supervision, sandbox escape/race tests, signal/timeouts, filesystem containment, quota preflight/harness safety and fake Control/Provider/Artifact adapters. Kernel quota exhaustion is not accepted until a dedicated exact-mountpoint `prjquota`/`pquota` environment exists.

## Acceptance

1. Reject unsigned, wrong-audience, expired, replayed, scope-widened or subject-mismatched claims.
2. Process crash/timeout/stop injection proves no surviving local process after accepted local stop.
3. Workspace, mount and resource containment adversarial tests; quota evidence from a dedicated provisioned filesystem.
4. No automatic retry after ambiguous process/provider outcome.
5. Clean Worker build and independent service identity; no Control or Governance DB access.

## Ownership record — fill before coding

| Field | Value |
|---|---|
| Accountable owner | UNASSIGNED |
| Branch/worktree | TBD |
| Exact files/crates | TBD; coordinate Worker composition root |
| Contract version | Draft `TaskClaimV1`, `CommandRequestV1`, `ProcessStopReceiptV1` |
| Consumer reviewers | Workstreams 2, 4, 5, 8 owners |
| Acceptance commands/evidence | TBD |
