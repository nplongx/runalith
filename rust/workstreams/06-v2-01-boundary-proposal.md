# WS6 proposal — V2-01 verifier ownership and authority boundaries

**Status:** PROPOSED / NOT RATIFIED. This is an ownership and module-boundary proposal, not an assignment of the mixed legacy files and not authority to change the current wire schema. No V2-01 Node source, test, register or inventory is changed by this proposal.

## 1. Exact current artifacts and verified state

- Shared Node verifier: src/runtime/adaptive-goal-knowledge-verifier.js, SHA-256 6bdc2e73d0d0eafeff3b4d78a8f849f463368003e235997956eb89d20bf53e6c.
- Shared test: tests/test-adaptive-goal-knowledge-verifier.mjs, SHA-256 85af0d678f59e2122f7aa2470316dd3ae273a3aecea510b63259e11a1f415931.
- The current Node test suite has 17 passing tests in the earlier evidence bundle. Its tests cover signatures, trust configuration observation/revocation/rollback, exact graph/evidence binding, persisted revalidation, replay, expiry, persistence faults and D-01 cross-database crash behavior.
- The module is mixed by semantics, not merely by naming. The source/test whole-file maintainer and merge owner remain UNASSIGNED. WS6 does not accept sole ownership of either file.
- The current V2-01 envelope pins a provider, scope, trust-root fingerprint, nonce and timestamps and signs the Goal/Idea snapshot and evidence-manifest digests. It does not carry a typed TrustSnapshotRefV1, explicit issuer/audience fields or a signed numeric configuration version. The in-process WeakSet authority marker is lost across serialization; a persisted/deserialized report must be independently re-read and reverified. These constraints must remain explicit in any successor contract.

## 2. Proposed semantic ownership split

| Existing behavior / responsibility | Proposed owner | Boundary |
|---|---|---|
| Trust configuration loading, configured domain/provider/scope, root lookup and domain separation | WS6 | Host-pinned trust identity; never inferred from attestation-supplied values alone. |
| Closed attestation envelope shape, canonical signed-byte profile, Ed25519 verification and signature digest | WS6 | Verify exact supplied bytes/claims; do not resolve source files or assert their lineage. |
| Key validity windows, revocation, configuration high-water/anti-rollback and verification-time freshness | WS6 | Use a host-owned trust observer and an explicitly supplied currentness/freshness contract. |
| Nonce one-time consumption, exact replay, changed-binding conflict and unavailable authority | WS6 policy; persistence owner undecided | A port contract can be defined; production adapter/schema/transaction owner remains gated by D-01. |
| Authentication marker and authenticated-decision freshness predicate | WS6 | An in-process marker is not a portable signed receipt and must not survive serialization as authority. |
| Goal/Idea current snapshot, node/edge/membership and revision integrity | WS7 | WS7 owns graph facts and the exact graph snapshot resolver. |
| Evidence-reference classification and artifact/source resolution | WS7 | WS7 owns source manifests, raw-byte digests, producer/attempt lineage and completeness. |
| Evidence-manifest canonical composition and digest | WS7 | WS6 consumes the resulting exact digest as an opaque signed subject component. |
| Task/experiment evidence coverage, membership provenance and graph-to-plan projection | WS7 | A signed claim cannot create missing producer lineage or make an incomplete manifest verified. |
| Persistence reads for graph/evidence/verification rows | WS7 | No direct cross-service SQL or private-store access from WS6. |
| Trust high-water and nonce persistence | WS6 semantic policy; durable persistence owner TBD | No implementation may assume that a second SQLite DB is transactionally atomic with the graph/workflow DB. |
| Existing createAdaptiveGoalKnowledgeVerifier composition façade and whole-file merge | UNASSIGNED integrator | Retain compatibility while extracting disjoint modules only after WS7 and Project Owner review. |

### Proposed module / public-port boundary

1. WS7 evidence resolver returns a typed, immutable GoalEvidenceSnapshotV1 (candidate name only) containing the exact Goal/Idea subject identity, snapshot digest, sorted node/edge/membership identity sets, exact evidence-manifest digest, and an explicit evidence/lineage disposition. It returns UNKNOWN/UNRESOLVED rather than manufacturing completeness when references are missing, duplicate, stale or ambiguous.
2. WS6 trust verifier accepts an opaque attestation plus the WS7-resolved subject/digests and host-pinned trust context (expected provider/domain/scope/issuer/audience when defined, exact TrustSnapshotRefV1, observed high-water, trusted-root selection, current time and nonce-consumption port). It verifies the closed envelope, exact canonical signed preimage, signature, subject and evidence digest bindings, key lifecycle, expiry/future-skew, high-water and replay.
3. WS6 result is an authenticated signed-decision result, not a new source-evidence fact. Candidate fields: schema version, Verified/Rejected signed claim, full signed-attestation digest, exact subject digest, exact evidence-manifest digest, trust-snapshot reference/digest, configured provider/key/root identity, nonce disposition and issued/expiry times. It must not contain a WS7-minted source lineage assertion.
4. WS7 composition/projection joins that authenticated decision to the same current evidence snapshot and applies its own graph and lineage rules. A signed Rejected remains non-authorizing. WS7 cannot mark evidence VERIFIED from an unsigned/local receipt or merely from a successful manifest construction.
5. Persistence integration uses explicit public ports. The verifier must not read or write WS7 tables, and WS7 must not read WS6 trust tables. The exact atomic commit/freshness fence, durable nonce ledger, inbox/outbox and revocation-to-commit behavior require a D-01 owner decision; no cross-database pseudo-transaction is proposed.

The legacy file is a temporary composition point. It should be extracted into WS6 trust-verification and WS7 evidence-composition modules only under a reviewed change plan with one named integrator; no concurrent whole-file edits are authorized by this proposal.

## 3. Test and review responsibilities

**WS6-owned tests**
- Closed envelope/unknown-field rejection and exact canonical signed-byte golden preimage/hash/signature vectors; Node/Rust differential coverage for the same bytes.
- Correct provider/domain/scope/issuer/audience and snapshot binding; wrong key/root, invalid signature, tampering and exact request/subject/evidence/policy digest mismatch.
- Key validity at issue and verification time, revoked/expired roots, stale or rolled-back high-water, future-issued/expired/boundary timestamps and invalid host clock.
- Nonce missing/unavailable fail-closed; one consumption, byte-identical replay, changed-binding conflict; independent connections, process concurrency and reopen/restart for a production-owned durable adapter when that owner/contract exists.
- No authority marker survives serialization; authenticated decision expires or becomes false when its registered currentness check fails.

**WS7-owned tests**
- Exact current graph revisions, node/edge/membership provenance, evidence-reference uniqueness and coverage.
- Artifact/source byte digest, manifest membership equality, producer/attempt lineage, missing/unresolved/duplicate/ambiguous evidence, and task/experiment evidence rules.
- Stale graph/evidence mutation invalidates projection; persisted readback never upgrades old evidence; graph proposal/projected plan remains non-executable without the independent authority decision.

**Joint public-port integration tests**
- WS7 resolver output is passed through a public typed interface; WS6 verifies only the exact supplied subject and manifest digests.
- Changed snapshot/manifest between resolution and commit fails closed under the eventual approved freshness fence.
- Authority unavailable, stale high-water, revocation, nonce conflict and storage failure preserve precise cause and UNKNOWN/UNRESOLVED; no auto-retry of ambiguous mutations.
- Tests use fakes for unapproved service dependencies, but no fake may be represented as production authority or persistence.

## 4. D-01 and current Node cross-database tests

The current Node verifier requires trustConfigurationDb to be distinct from the Goal/Idea workflow DB. Its tests demonstrate that a trust observation can commit in that database before a workflow attestation write fails or the process is killed; the workflow transaction rolls back while the trust observation remains. The tests also demonstrate fail-closed behavior under trust-ledger writer contention and a safe retry in the test setup.

This is valuable fault evidence, but it does not prove an atomic transaction across the two databases, a commit-time revocation fence, production nonce durability, or approval of a two-database topology. It must not be used to bypass the unresolved D-01 decision. Project/architecture Owner must name the topology and transaction owner and ratify ordering, freshness, revocation, restore/epoch and failure semantics before persistence integration or cutover.

## 5. TrustedSkillResolutionV1 — acceptance gap and safe next step

A repository-wide exact-name review found no TrustedSkillResolutionV1 implementation in runalith-trust, runalith-protocol, the Node runtime or tests. WS1's seven-field/manifest V2 direction has only been accepted for planning; its current four-field SkillPinRefV1 remains unchanged. The two supplied portable-manifest vectors have narrow Node/Rust byte parity, not a production importer or trusted-skill authority.

A future resolution contract must bind the immutable skill identity/version, manifest profile and bundle digest, exact trust snapshot reference, authority receipt identity/digest, and the consumer's compiled-plan digest; it must additionally specify freshness, revocation, expiry and nonce semantics. WS6 may verify such a receipt only after WS1 ratifies the producer/consumer fields and the Project Owner appoints the trusted-skill trust domain, issuer/audience/scope, root/key custodian and durable nonce owner. This proposal deliberately chooses none of those values and does not add a public DTO, mutate SkillPinRefV1, or treat manifest-byte parity as a trust decision.

## 6. Review requested / decision record

WS7 is asked to:
1. Confirm or correct the WS6/WS7 semantic split and the proposed immutable evidence-snapshot public port.
2. Identify the named maintainer/integrator for the legacy verifier/test files, or explicitly state UNASSIGNED.
3. Confirm which source/evidence fields must be bound into the attestation subject and which are WS7-only facts.
4. Identify any missing WS7 tests for manifest equality, source lineage, task/experiment coverage or projection currentness.
5. Supply the current source/test hashes and a versioned successor contract before changing V2-01 schema semantics.

Project Owner / architecture authority is asked to name the D-01 persistence/topology owner and decide the trust high-water/nonce/freshness commit fence. Until then, no database migration, cross-database transaction, production nonce service or revocation cutover is authorized.

**Disposition:** PROPOSED / REVIEW REQUESTED / NOT RATIFIED. Queued or delivered A2A messages are not owner acceptance. No source assignment, schema ratification, authority provisioning or production claim is implied.


## 7. WS7 subject golden and authenticated-decision DTO conditions (2026-11-03)

- WS7 inbox event seq 1058, message `9ce261b1-1d8e-44ef-a3a8-36fd77b62acf`, ACKs the confirmed V2-01 subject and supplies a golden candidate. The source fixture at `ws7-evidence/fixtures/goal-evidence-v2-01-subject-v1-golden.json` has SHA-256 `cfa3d3fa502e2b0af745e08837e8b461fbb3be44986265fe03e529760529186e`.
- The subject object remains exactly five properties and no additional keys: `goal_id`, `idea_id`, `graph_revision`, `graph_snapshot_sha256`, `evidence_manifest_sha256`. The fixture profile label is `restricted-JCS-UTF8-closed-five-field-subject-v1`; canonical UTF-8 is `{"evidence_manifest_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","goal_id":"goal-42","graph_revision":17,"graph_snapshot_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","idea_id":"idea-42"}` and subject SHA-256 is `81ef500643ded8865c2a6ba1d20b0a2d58dcedb15daead85f6b6ec554b6dd5b4`.
- The profile/version identity is metadata on the proposed authenticated-decision DTO, outside the five-field subject digest object. Candidate field: `subject_profile_id`, with the exact WS7 profile label above. This prevents a consumer from interpreting the new five-field subject as the existing six-field `EvidenceVerificationSubjectV1`; that existing V1 subject/receipt/signature remains unchanged.
- `signed_claim_status` preserves only the claim authenticated in the signed attestation (`VERIFIED` or `REJECTED`). It is not WS7's local evidence completeness, freshness or producer-lineage status. WS7 re-resolves and independently evaluates its graph/evidence facts.
- `nonce_disposition` is present only after a durable nonce consume or exact replay decision. When that authority is unavailable/unassigned, no authenticated decision receipt is issued; result remains `UNKNOWN/UNRESOLVED`. D-01 durable nonce ownership, snapshot/high-water currentness and commit fence remain blockers.
- WS7's focused `node --test tests/goal-evidence-snapshot-port-v1.test.mjs` result is peer-reported 11/11 PASS, including canonical bytes/hash and independent currentness revalidation. WS6 has not modified WS7 sources, fixtures or schemas.
- WS6 response `6ebcb019-be98-4db9-8523-e16a64fec37a` is queued/durable and atomically ACKed WS7's message; this is a correlated reply, not a wire-schema ratification or production authority appointment.

**Disposition update:** WS7 accepts the five-field subject and authenticated-decision shape for further contract drafting with the conditions above. This does not ratify the authenticated-decision DTO, Common Envelope, trust identity, nonce persistence or V2-01 runtime integration. Overall proposal remains PROPOSED / NOT RATIFIED.
