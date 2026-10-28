# Live remediation runbook — Goal/Idea → Plan → Execution Graph (RC.26)

**Observed status: `BLOCKED`; no live Execution Graph was created.** This document records the live diagnostic observed on 2026-10-28 and defines the required closure sequence. It is an operator runbook, not a trust attestation, release approval, or authorization to dispatch.

## Current live observation

Read-only checks against the installed plugin returned:

| Check | Observed value |
|---|---|
| Installed plugin | `runalith-agent-orchestrator` `1.0.9-rc.26` |
| Runtime health | `ok`, mode `local-only-mcp` |
| Runtime entrypoint startup SHA-256 | `2f791884c8d2e3caf5740dedb77f1c9c26d7d0132eeb3fc4f01170e59d3fe4d1` |
| Manifest startup SHA-256 | `bebc5ac0389882cc5ec2c80c872610e1df21e04aa1e483c79210ee374ebd2e5a` |
| Goal/Idea verifier | `KNOWLEDGE_VERIFIER_NOT_CONFIGURED`; config environment value is blank |
| Action-intent reviewer | `AGG_TRUST_CONFIG_NOT_CONFIGURED`; config environment value is blank |
| Diagnostic Goal/Idea scope | `runalith-agg-e2e-20261026-clean` |
| Current snapshot hash | `80001cbece6811f7e3a0c187662393f05393ed11421767b23d76548c77c32bf3` |
| Evidence manifest | Empty; hash `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| Attestation eligibility | `false`; blocker `KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY` |
| Live health counters | 137 jobs, 85 active jobs, 60 executing jobs, 1,277 tasks, 5,308 events |
| External/cloud execution | Disabled |

The current diagnostic scope contains seven nodes, seven edges and seven memberships, but no node/edge evidence references. The records are explicitly caller-authored and unverified. **Do not attach fabricated references to these historical diagnostic nodes or re-label their claims as verified.** Create a fresh, correctly scoped graph only after admissible producer artifacts exist.

The live workflow store also contains unresolved executing/running work. Do not add live producer workflows, bulk-reset jobs, terminate tasks, change lease state, or dispatch work until workflow owners/providers have reconciled the existing records and authorized the intended scope. A missing lease is not proof a worker is dead.

## Closure sequence

### 1. Provision both independent trust domains

The host/security authorities must provision the two versioned, public-key-only JSON trust configurations through the host-supported plugin configuration mechanism. They must be administered separately and use distinct provider IDs and disjoint Ed25519 SPKI roots.

| Domain | Environment variable | Exact scope |
|---|---|---|
| Goal/Idea claim verifier | `AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON` | `agg.goal_idea_graph.verify` |
| Action-intent reviewer | `AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON` | `agg.action_intent.review` |

Use the validator only with authority-issued files; replace these example paths with the protected files actually provisioned by the authorities:

```sh
node scripts/validate-agg-trust-config.mjs \
  --domain goal_idea_verifier \
  --config /secure/admin-input/goal-idea-verifier.json \
  --peer-config /secure/admin-input/action-intent-reviewer.json \
  --require-peer-config

node scripts/validate-agg-trust-config.mjs \
  --domain action_intent_reviewer \
  --config /secure/admin-input/action-intent-reviewer.json \
  --peer-config /secure/admin-input/goal-idea-verifier.json \
  --require-peer-config
```

Both commands must report `PASS` and `PAIR_SEPARATION_VERIFIED`. Then verify the **installed process**, not just these files: `adaptive_goal_trust_configuration_status` must report both domains available, distinct provider identities, disjoint roots and valid configuration/ledger state. Offline validation alone does not prove host provisioning. Do not generate production roots, expose private keys, set ad-hoc environment values in the running process, or use disposable test keys.

### 2. Produce new, admissible evidence through the approved workflow lifecycle

After the workflow owner authorizes an isolated scope and the live-work reconciliation policy permits it, run the standard producer path. The nine mandatory typed outputs in the existing producer contract are:

| Task binding | Capability | Required typed artifact |
|---|---|---|
| `standard-product-owner` | `product.requirements` | `requirements` |
| `standard-researcher` | `research.collect` | `research` |
| `standard-architect` | `architecture.design` | `architecture` |
| `standard-engineer` | `code.modify` | `implementation` |
| `standard-security` | `security.audit` | `security-review` |
| `standard-qa` | `code.verify` | `qa-report` |
| `standard-platform` | `infrastructure.verify` | `platform-review` |
| `standard-writer` | `documentation.write` | `documentation` |
| `standard-reviewer` | `change.review` | `review` |

Each `artifact://` reference must resolve to actual persisted artifact bytes with the expected typed schema and verified digest, produced by the mapped successful task/result/attempt. The normal lifecycle must include the canonical artifact-created and task-completion events and all DAG prerequisites. A file path, telemetry row, test fixture, label, caller-supplied hash, stale artifact from another job, or a manually typed `artifact://` string is not sufficient evidence.

Create a fresh Goal/Idea graph from the actual outputs and their provenance. Its `adaptive_goal_knowledge_snapshot_get` response must show a non-empty resolved evidence manifest, no integrity issues, and `eligibleForAttestation: true` before requesting verification. Evidence hashes establish integrity/lineage; an independently trusted verifier must still adjudicate claim truth and evidence independence.

### 3. Verify and project the exact current snapshot

The independent verifier must sign the exact current snapshot and evidence-manifest binding, including the issued nonce, expiry, provider, trust-root fingerprint, node/edge/membership state and artifact lineage. Persist the signature through `adaptive_goal_knowledge_snapshot_attest`, then fetch the snapshot again and confirm `currentVerification.verified: true` for that exact hash.

Use `adaptive_goal_knowledge_graph_search` only with the freshly revalidated snapshot hash and the persisted start/goal member IDs. Create the Plan Graph in **verified mode**, then read it back. Every step must have resolvable `supportingEvidenceRefs` tied to the intended producer outputs. Check structural compatibility separately from evidence readiness; `contractReady: true` is not evidence readiness.

### 4. Require readiness before creating the Execution Graph proposal

Run `adaptive_goal_execution_readiness_check` against the exact stored Plan Graph draft and binding set. Continue only when all of the following hold:

- `contractReady: true` and `evidenceReady: true`;
- `readyForExecutionGraphReview: true`;
- every required step has its evidence reference(s) resolved and lineage-verified;
- no `STEP_EVIDENCE_MISSING`, unavailable-input, schema, producer-lineage, snapshot, or trust blockers remain.

Then call `adaptive_goal_execution_graph_proposal_create` with the stored Plan Graph proposal ID and all nine exact step/task/capability bindings. Read the resulting proposal back and revalidate it. A successful call creates a **review-only proposal**, not executable contracts, an immutable executable plan, approval, dispatch, or execution.

### 5. Keep approval, reviewer identity, and dispatch as separate gates

The action-intent reviewer must authenticate the exact action candidate/plan using the independently administered reviewer domain. A human must inspect the current evidence and approve the exact proposal through the supported workflow interface. Do not infer execution authorization from a passing compatibility check, a stored proposal, a verifier attestation, or human review alone. Dispatch remains prohibited unless the complete runtime authorization and workflow gates independently pass and the authorized operator explicitly approves the exact action.

## Validation that can safely run now

These checks use disposable SQLite state and disposable test-only Ed25519 keys. They validate implementation behavior but do **not** alter the installed host trust configuration or close the live blockers:

```sh
node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs
node --test tests/test-adaptive-goal-trust-configuration.mjs tests/test-adaptive-goal-trust-entrypoint.mjs
node --test tests/test-adaptive-goal-graph.js tests/test-adaptive-goal-execution-readiness.js tests/test-adaptive-goal-execution-graph-proposal.js
```

The isolated producer E2E must continue to prove the full producer → typed artifacts → verified snapshot → Plan DAG → evidence readiness → review-only Execution Graph proposal chain, while retaining negative assertions for forged metadata, invalid lineage, missing references, replay/expiry and disabled production authority. Test keys and test artifacts must never be copied to the host configuration or live Goal/Idea graph.

## Completion criteria

Do not mark this path complete until there is a fresh trusted Goal/Idea snapshot with admissible evidence, a verified Plan Graph with all required supporting references, a clean readiness result, and a successfully read-back Execution Graph proposal bound to that exact plan. Record reviewer approval separately. Keep production dispatch and rollout blocked until their independent authorization and lifecycle-drain predicates are satisfied.
