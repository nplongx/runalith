# Runalith domain language

This glossary defines the product and domain terms shared across Runalith's workflow, execution, Adaptive Goal Graph, evidence, and trust boundaries.

## Workflow and execution

**Workflow**:
A governed unit of work whose proposal, approval, tasks, evidence, and completion are tracked as one lifecycle.
_Avoid_: Job (when referring to the whole user-facing lifecycle), run (when the durable workflow is meant)

**Workflow proposal**:
A requested workflow definition awaiting explicit authorization; creating or inspecting a proposal does not permit execution.
_Avoid_: Approved workflow, executable workflow

**Immutable execution plan**:
The approved contract that fixes the tasks, dependencies, role requirements, success conditions, and execution constraints for one workflow.
_Avoid_: Draft plan, mutable plan

**Task**:
A bounded unit of work within an immutable execution plan, with its own lifecycle and required completion evidence.
_Avoid_: Step (when referring to a durable task)

**Execution evidence**:
Durable records demonstrating what a task actually did and how it ended; a narrative assertion alone is not execution evidence.
_Avoid_: Completion claim, success statement

**Evidence lineage**:
The provenance relationship connecting an artifact to the successful producer result, attempt, and task that created it.
_Avoid_: Artifact hash alone, provenance inferred from a filename

**Policy pack**:
A reusable, versioned set of workflow constraints and success conditions evaluated against the approved workflow contract and its evidence.
_Avoid_: Permission grant, capability grant

**Explicit approval**:
An authorization decision over the exact workflow proposal and immutable execution plan; proposal creation, preview, reviewer identity, and policy attachment are not approval.
_Avoid_: Confirmation string, reviewer attestation

## Adaptive Goal Graph

**Adaptive Goal Graph (AGG)**:
A planning and evidence subsystem that turns goal/idea knowledge into reviewable plan and execution proposals while relying on the normal workflow lifecycle for authorization and execution.
_Avoid_: Separate execution engine, autonomous dispatch authority

**Goal/Idea Graph**:
Versioned knowledge about goals, ideas, relationships, and their provenance; storing a node or edge does not establish that its claim is true or eligible for planning.
_Avoid_: Verified knowledge (unless the exact snapshot has passed its verification contract)

**Search candidate**:
A proposed route through a Goal/Idea Graph produced by a bounded search process; it is a heuristic result, not a verified claim or executable plan.
_Avoid_: Approved plan, verified goal

**Plan Graph draft**:
A reviewable candidate path mapped to an existing workflow template; it does not itself define an immutable execution contract or authorize dispatch.
_Avoid_: Immutable execution plan

**Execution Graph proposal**:
A review-only mapping from proposed actions to workflow tasks, checked against role requirements, typed inputs, and evidence lineage.
_Avoid_: Executable graph, standalone workflow

## Trust and authorization evidence

**Knowledge snapshot attestation**:
An external verifier's signed decision about one exact Goal/Idea Graph snapshot and its evidence manifest.
_Avoid_: Candidate approval, reviewer identity attestation

**Reviewer identity attestation**:
A trusted identity provider's signed assertion that a reviewer made a scoped decision about an exact candidate and its bound semantics; it is not workflow approval.
_Avoid_: Workflow approval, source verification

**Trust configuration**:
An administrator-provisioned definition of which provider and public trust roots are accepted for a specific authorization scope.
_Avoid_: Locally generated production trust, private signing key

**Trust configuration history**:
The durable history of observed trust-configuration versions, fingerprints, providers, and root identities; this history records observations but is not an independent trust authority.
_Avoid_: External checkpoint authority

**Trust-ledger observation**:
A durable record that a trust configuration has been checked against its previously observed high-water state.
_Avoid_: Approval decision, external checkpoint

**Security-critical state**:
Durable information that can change whether a candidate, reviewer, policy, trust root, approval, or dispatch is authorized.
_Avoid_: Security data (too broad; may include unrelated logs or secrets)

**Security projection**:
The precisely defined set of security-critical facts whose combined state is represented by a checkpoint version.
_Avoid_: Database hash, file hash

**External checkpoint authority**:
An independently administered authority responsible for monotonic checkpoint custody, attestation appraisal, and recoverable operation status.
_Avoid_: Local trust ledger, plugin-managed trust state
