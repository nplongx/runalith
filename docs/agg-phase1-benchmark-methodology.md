# AGG Phase 1 Benchmark Evidence and Reproduction

**Status:** supplemental engineering evidence only; this document does not approve corpus, change the frozen protocol, or authorize execution.
**Scope:** Idea Graph + Beam Search, supplied-graph algorithm selection, optional local model-backed graph selection, and separately gated operational workflow comparison. Discriminator, MCTS, and Phase 2–4 are out of scope.

## Frozen acceptance protocol remains authoritative

The original operational protocol remains in `plugin-workflow-benchmark-plan.md` and `plugin-workflow-benchmark-phase1-freeze.md`. Their contents and hashes are not rewritten by this work. The frozen rubric is 100 points (planning/orchestration 20, failure/recovery 25, safety/permissions 25, result verification 15, reporting/traceability 15); 70–84 remains supervised-only, 85+ remains potential subject to every safety gate, and the same five hard-fail conditions remain mandatory. The protocol still requires the same ten operational scenarios and a paired plugin-enabled versus basic-tools condition with equal environment, inputs, permissions, and acceptance criteria.

The original benchmark PDF was not present in the repository or in the searched workspace tree during this run. The checked-in plan and historical freeze are the sources available to this reproduction; no PDF contents have been inferred or reconstructed.

## Keep three evaluation layers separate

### A. Algorithm benchmark on an existing graph

Command:

```sh
node benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs \
  --output artifacts/phase1-benchmark-raw-NEW.json \
  --report artifacts/phase1-benchmark-report-NEW.md
node benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs \
  --raw artifacts/phase1-benchmark-raw-NEW.json \
  --manifest artifacts/phase1-benchmark-raw-NEW.json.manifest.json
```

This preserves the frozen synthetic development/regression catalog and its original method definitions: deterministic linear CoT-style, deterministic bounded ToT-style tree search, and AGG Beam widths 1/2/4. Every compared method receives the same preconstructed input graph for a matched task instance and the same declared search budget. The oracle recomputes route feasibility, prerequisites, conflicts, route stages, evidence-reference coverage, and no-solution validity independently of the method under test.

The frozen run has 28 task templates nested in 7 task-family clusters. Five fixed repeat seeds create 140 graph instances; five methods produce 700 raw trial records. The 140 graph instances are repeated/seeded variants of only 28 templates and 7 family structures, not 140 independent production tasks. Bootstrap uncertainty therefore resamples task-family clusters and keeps the paired template/seed observations together. With only seven synthetic family clusters, intervals are descriptive and may be degenerate. An interval containing zero is inconclusive, not proof of equivalence. No power/sample-size claim is made because this corpus does not define an owner-approved minimum practically important effect and the one-task model pilot is not a valid power pilot.

The catalog's fixed expansion cap is a cap on the search method's successor-expansion counter, not an equal-total-computation budget. ToT's graph-wide heuristic preprocessing is measured separately and included in whole-method CPU/wall time but is not charged to that expansion cap; CoT filtering/lookahead and the other methods also have different implementation overhead. The runner discloses this distinction rather than claiming equal total compute. Interpret the fixed-cap success results together with measured wall/CPU costs; a true equal-total-work comparison would need a separately specified and validated work unit before data collection.

This set is a frozen synthetic development/regression set, not a secret or owner-approved acceptance holdout. It must not be presented as representative operational data. No corpus, grader rule, rubric, score band, hard-fail rule, or ten-case protocol may be changed after looking at results. Any proposed acceptance corpus change requires explicit owner approval, a versioned protocol decision made before its results are examined, and a separately held-out test set.

### B. Model-backed selection from the same supplied graph

Command (only where local model access and an authorized run budget exist):

```sh
node benchmarks/adaptive-goal-graph/run-local-llm-phase1-benchmark.mjs \
  --input artifacts/phase1-benchmark-raw-NEW.json \
  --output artifacts/phase1-local-llm-NEW.json \
  --report artifacts/phase1-local-llm-NEW.md
node benchmarks/adaptive-goal-graph/verify-local-llm-phase1-ledger.mjs \
  --raw artifacts/phase1-local-llm-NEW.json \
  --manifest artifacts/phase1-local-llm-NEW.json.manifest.json
```

The model runner only accepts a literal loopback HTTP endpoint; it does not accept remote API URLs. It records provider/version, model digest, prompt and output hashes, model options, per-trial input/output tokens when reported, call counts, timeout, trial identity, retry policy, graph/config/dataset/source/grader hashes, and failure records. It performs no retries and does not create a completed raw/report after a failed call. Partial JSONL and a separate incomplete manifest preserve failed attempts instead of fabricating replacements. Local engine tokens are not monetary costs; USD remains unknown unless a price source and actual measured usage have been recorded.

`llm-chain` is model-backed chain-style planning. `llm-tot-prompted` is explicitly a one-shot ToT-style prompt, not canonical multi-call Tree of Thoughts. This benchmark supplies a complete graph to each method; it does not measure model-driven Idea Graph creation, tool interactions, evidence retrieval, or end-to-end workflow cost. Those costs must be measured in their own operational layer.

Mock loopback integration tests validate runner behavior and failure handling; their records are not model results. The historical one-task local Ollama pilot remains n=1 and cannot estimate power or establish a model-backed improvement. A new actual model run must not be invented from mock results or aggregate estimates.

### C. Operational end-to-end workflow benchmark

This remains the original ten-scenario protocol: plugin-enabled (A) versus basic tools only (B), same initial state/input/environment/permissions and original rubric. Preserve all raw paired runs, failures, timeouts, retries, interventions and unknown outcomes. Measure the entire path for both branches: graph generation, planning, tool calls, evidence validation, verification, retries, and failed attempts, plus success and hard-fail outcomes, latency distribution, CPU/memory where measured, and actual monetary cost only when tied to verifiable provider usage/pricing.

Neither the synthetic algorithm benchmark nor the model-selection-from-supplied-graph benchmark is a substitute for these operational results. Do not run or label synthetic fixtures as operational. Current release evidence must continue to say `PARTIAL_NOT_ACCEPTED` until the owner-approved corpus and evaluation signatures, trusted reviewer identity/attestation, independent approvals, and actual paired operational raw records meet the frozen gates.

## Ledger and statistical integrity

Schema-v5 algorithm runs use unique `taskInstanceId` and `trialId`, embedded per-record source/configuration/dataset/grader hashes, one attempt and zero retries, explicit timeout/error/exit fields, raw selected output, and a manifest binding raw/report paths, hashes, sizes, command, seed list, method list and counts. The configuration hash explicitly binds the fixed successor-expansion budget scope and the fact that total computation is not equalized. Output files are created exclusively and never overwrite historical evidence. The sidecar manifest itself must be anchored by the enclosing evidence pack's SHA-256 file list; a mutable sidecar alone is not a signature.

The independent ledger validators are read-only. They recompute the task oracle and inspect every matched method record, graph hash, seed, budget, trial count, duplicate/missing row, outcome/summary agreement, paired contingency table, statistical output, provenance hash, and manifest/file digest. Schema-v4 historical runs are audited only with `--allow-historical-source` and cannot be represented as runs of the current source version. The validator returns `PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE`, never approval or acceptance.

For paired comparisons, report both-correct, A-only-correct, B-only-correct, and both-incorrect counts; task-instance success rates and A-minus-B difference; and 95% family-cluster bootstrap intervals. Keep every failure in the denominator under the predeclared policy. Repeated trials improve measurement of repeat variability but do not substitute for task diversity. Statistical uncertainty and task validity are separate from operational readiness and safety gates.

## Verification commands

```sh
node --test \
  tests/test-adaptive-goal-phase1-benchmark.mjs \
  tests/test-adaptive-goal-benchmark-integrity.mjs \
  tests/test-adaptive-goal-local-llm-failure.mjs \
  tests/test-mcpb-candidate-integrity.mjs
npm test
npm run docs:check
npm run test:mcpb-candidate -- artifacts/runalith-1.0.9-rc.5-candidate-agg-phase1-semantics-index-20261022T1033Z.mcpb
```

The MCPB candidate test checks archive path/entry safety, manifest/package consistency, packaged server initialization, tool-list schema parity, and health in a disposable temporary state directory. It is a packaged-runtime smoke test, not the frozen ten-scenario acceptance suite, independent approval, or production sandbox proof. Do not install the candidate in order to perform this check.

## Runtime and authority gates are independent

The live readiness check is read-only. `contract_ready_evidence_pending` means producer/consumer contracts were structurally compatible but zero durable source artifacts resolved for four mapped steps. It does not authorize creating an Execution Graph. Trust root, provider identity, reviewer signature, independent approval, source/intent/graph/plan hash binding, sandbox isolation and live E2E execution are separate gates. No event/result/receipt/artifact may be manufactured to clear them. Only `implement-fixture-validator-v1` is allowlisted for disposable test-harness execution; this does not establish production execution authority.

### Phase 1 scorer trust boundary (hardened)

The operational `score` command requires a host-administrator-provisioned `/etc/runalith/agg-phase1-trust-anchors.json` file. The trust-anchor config must be a non-symlink regular file owned by root, no larger than 16 KiB, and not group/world writable; `/etc` and `/etc/runalith` must likewise be real root-owned directories not writable by group/world. Reads use stable regular-file descriptors with no-follow semantics and identity/timestamp checks; the exact public-key bytes used for signature verification must equal the pin read from this protected config. A caller-supplied key, evidence-side key, changed path or valid signature under a different key cannot establish trust. Its duplicate-key-free JSON schema is exactly:

```json
{
  "schemaVersion": 1,
  "ownerTrustRootSha256": "<SHA-256 of the exact owner Ed25519 public PEM bytes>",
  "reviewerTrustRootSha256": "<SHA-256 of the exact independent-reviewer Ed25519 public PEM bytes>",
  "evaluatorTrustRootSha256": "<SHA-256 of the exact benchmark-evaluator Ed25519 public PEM bytes>",
  "isolationAuditorTrustRootSha256": "<SHA-256 of the exact independent-isolation-auditor Ed25519 public PEM bytes>"
}
```

All four pins must be distinct. The verifier reads this protected configuration from a fixed path and does not accept environment variables or a config path supplied by the caller as trust-anchor authority. This implementation does **not** create the file or generate a trust root; the config is currently absent in this workspace, so operational scoring remains blocked.

Production adjudication additionally requires an owner-signed one-shot gate-consumption receipt (`--gate-consumption-receipt`) and the fixed host-side ledger `/var/lib/runalith/agg-phase1-execution-gate-consumptions.jsonl`. The verifier is read-only: it never authorizes, consumes, or opens the gate. It checks the receipt against the pinned owner key; the current candidate/source, approved corpus, raw-run ledger, exact execution-ID set, and fresh authorization hash/nonce; and exactly one `CONSUMED_ONCE` ledger row whose decision/authorization/receipt nonces are unique. The ledger and its parent directories must be root-owned and not group/world writable; production callers cannot redirect the ledger. A missing ledger/receipt, duplicate authorization nonce, altered run set, expired/future consumption time, wrong role/scope, or hash mismatch fails closed. These are prerequisites for adjudicating evidence, not permission to run the benchmark: the external gatekeeper must record consumption after a valid authorized decision and before the exact runs start. This workspace has no provisioned ledger or valid current-target receipt, so this path has not been used operationally.

The current protocol does not define or consume a signed attestation revocation list. Expiration and trust-root pin replacement are checked, but those are not equivalent to per-attestation revocation. The one-shot ledger prevents duplicate consumption records for the same decision/authorization/receipt in the current protected ledger; it is not a revocation service. Do not state that a signature has passed revocation checks; if revocation becomes an acceptance requirement, it needs a separately provisioned authenticated registry and versioned protocol/test contract before any operational gate could pass.

### Attestation envelope and freshness

New acceptance attestation envelopes use `schemaVersion: 2` and the exact `protocolVersion: "plugin-workflow-orchestration-phase1@1"`. Closed schemas reject unrecognized/missing fields and older schema versions. Signature inputs are the canonical JSON bytes of the full envelope excluding only `signature`; Ed25519 signatures must decode as canonical base64 to exactly 64 bytes. Issued/expiry timestamps must be canonical UTC ISO strings, issued-at cannot be materially future-dated, expiry must be after issuance and current time, validity duration is bounded, and nonce values must use the declared bounded syntax.

The owner corpus-approval signature binds exact candidate-bundle SHA-256, source-snapshot SHA-256, corpus ID and corpus bytes, plus frozen plan/freeze hashes and approval scope. Independent review binds candidate/source/proposal bytes and frozen protocol hashes. Operational authorization binds candidate/source/corpus bytes and frozen protocol hashes. Evaluator attestation binds candidate/source, corpus and exact raw-ledger bytes. Isolation attestation and each underlying isolation evidence document bind candidate/source/corpus/raw-ledger hashes, the exact protocol version and all execution IDs. A package hash alone is not source alignment: the current source-to-binary verifier must confirm every shipped archive entry and the package metadata projection.

Operational authorization is checked against the actual run window, not merely the time when someone later requests a score: the first scenario must start no more than 15 minutes after authorization issuance, and authorization must remain valid through the last scenario and adjudication. The owner, reviewer, evaluator, and isolation auditor require distinct pinned keys and distinct attested subjects. All attestation nonces in a single acceptance packet must be unique. This per-packet check does not replace durable one-shot execution-gate custody: the frozen scenario gate must remain closed until the authorized gate custodian verifies prerequisites, records consumption durably, and transitions the gate under the separate authorization process. The scorer does not itself open the gate or execute scenarios.

The operator must supply `--independent-review`, `--reviewer-trust-root`, `--operational-authorization`, `--isolation-attestation`, and `--isolation-auditor-trust-root` in addition to the corpus/evaluator inputs. The signed review binds exact candidate archive, computed source-snapshot hash, target-proposal bytes and frozen plan/freeze hashes. The fresh owner authorization binds exact candidate/source/corpus bytes, frozen plan/freeze hashes and exact operational A/B scope. The separate isolation auditor binds exact candidate/source/corpus/raw run ledger bytes and frozen plan/freeze hashes. It must sign three separately SHA-256-pinned evidence files: OS/container isolation controls, network-deny controls and process/resource quota controls. Each evidence file must list every execution ID in the signed run ledger, declare every required control `PASS`, match `protocolVersion`, and be hash-verified by the scorer. Owner, reviewer, evaluator and isolation-auditor keys and attested subjects must be distinct. A PEM placed beside the corpus or supplied only by a caller cannot establish trust by itself. The historical owner direction chooses an engineering target; it is not one of these attestations.

For non-fixture scorer inputs, artifact DAG validation also rejects cycles in `parentArtifactIds`; valid hashes alone do not establish valid lineage if dependencies recursively point back to an ancestor.

Unit tests may exercise signature and scoring structure only through explicit `allowTestFixtures: true`; those reports are forced to `TEST_FIXTURE_ONLY_NOT_ACCEPTANCE`, and the CLI has no test-fixture bypass. Static readiness checks the protected trust-config custody/shape but does not accept review, corpus, isolation or authorization inputs, and remains blocked until real trusted evidence is supplied. A pinned key alone is not a review, operational authorization, corpus attestation, evaluator attestation, or sandbox proof.

**Current acceptance label: `PARTIAL_NOT_ACCEPTED`.** The configured frozen target remains the owner-directed target; `readiness --candidate PATH` is diagnostic-only and reports observed archive/source alignment without changing target identity or transferring approval. The development candidate with SHA-256 `7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0` differs from the configured target `9d836dca9daec26b53a104f99028fb30fd11848e8c0a8764c4eb7dedd45e1c37`; it is not formally approved. A target change requires a fresh owner-directed proposal binding exact archive and source-snapshot hashes, owner re-freeze/approval and independent review. The protected trust-anchor directory is absent, as are owner-signed corpus, fresh exact-scope authorization, actual paired operational runs, independently signed adjudication and production isolation evidence. Algorithmic integrity can pass while operational A/B, reviewer trust, durable evidence lineage, live readiness, or production-grade isolation remains blocked. No automated score or integrity validator promotes the overall Phase 1 status.

The readiness CLI accepts `--candidate REPOSITORY-RELATIVE-MCPB` (and `--output NEW.json`). This option is strictly diagnostic: it requires a canonical regular non-symlink file under the repository, inspects exact candidate bytes and source alignment, and reports whether those bytes match the configured target/proposal. It never rewrites the configured target, proposal, owner direction, historical approval or execution gate. A mismatch is a blocker, not a request to update the frozen target hash.

### Exact Phase 1 / Phase 2 package boundary

The `76 entries / 67 manifest tools` Phase 1 candidate and the frozen `71 entries / 59 tools` Phase 2-shaped reference both advertise package version `1.0.9-rc.5`, so the version string alone is not a safe package identity. The preserved historical Phase 2 reference is `artifacts/runalith-1.0.9-rc.5-agg-test-20261021T092406Z.mcpb`, SHA-256 `2e9937d309e0c3085f9bf789b38ceff21b91c6fc093ba4ee344cf214c173a956`; its contents are used for count/manifest comparison only, not as current-source verification or approval. Relative to that exact reference, the current Phase 1 package has five additional paths (`adaptive-goal-evidence-lineage.js`, `adaptive-goal-knowledge-store.js`, `adaptive-goal-sandbox-executor.js`, `adaptive-goal-source-evidence.js`, and its evidence-lineage test) and eight additional tool schemas (knowledge-store/recovery plus sandbox execution). That is a distinct package contract, not a harmless ZIP-entry-count fluctuation.

Do not pass the Phase 1 candidate into the Phase 2 exact-inventory acceptance test and then reinterpret the expected `76 !== 71` assertion as a Phase 1 failure; do not trim archive entries or change the frozen count. The replay now records a separate machine-readable package-boundary diagnosis against the hash-pinned historical reference. A future shared release/version claim still requires owner-approved versioned package/contract separation and fresh approval of the exact current target; the same `rc.5` manifest string is not that approval.

### Reproducible hardening pipeline

For a fresh, append-only evidence pack from the current dirty working tree, choose a directory that does not exist and run:

```sh
npm run agg:phase1:replay -- --output-dir "$PWD/artifacts/agg-phase1-hardening-NEW"
npm run agg:phase1:verify-evidence -- \
  --evidence-dir "$PWD/artifacts/agg-phase1-hardening-NEW" \
  --source-root "$PWD"
```

The replay command captures Git HEAD/status, a tracked binary patch, an untracked source overlay (excluding historical `artifacts/` payload), tool versions and per-command exit/log hashes. Each command has separate raw stdout/stderr sidecars; the verifier requires the complete 20-command roster, recomputes their SHA-256 values and reconstructs each combined log from exact captured bytes and receipt metadata. This proves pack self-consistency, not cryptographic authenticity of the local process that originally emitted a log. The default path runs focused AGG/Phase 1 tests, `npm test`, docs checks, two-build reproducibility/no-overwrite tests, MCPB build with extracted-package E2E, source-byte alignment, candidate smoke, the offline graph benchmark and integrity ledger verifier, and read-only official readiness. If packaged archive inputs have not changed and the exact historical development candidate is still source-aligned, use `--preserve-existing-candidate "$PWD/artifacts/agg-phase1-hardening-20261023T134921Z-end-to-end/runalith-1.0.9-rc.5-agg-phase1-hardened.mcpb"`; this path pins the expected SHA-256 `7fb5f547eda71a717d10358510e1ea7baee46f5f9bcea3efc2891c6293bd3bc0`, checks current source alignment before copying exact bytes, and records package reproducibility and extracted-package E2E as `SKIPPED` with explicit reasons. It does not rebuild or imply that source-only scorer/test changes are inside the candidate. If alignment fails, preservation mode fails closed; do not use it to conceal a packaged-input change. Only use the default build path when package inputs really changed. The verifier checks that skipped commands were not reported as passing executions. The replay reconstructs the captured source snapshot in a clean detached clone by checking out the recorded Git HEAD, applying the captured tracked patch, validating and extracting the source overlay without overwriting tracked paths, checking locally excluded frozen-doc hashes, and recomputing source-to-binary provenance against the captured candidate bytes. The independent verifier does not trust the producer's reconstruction `PASS` flag alone. It also records a separate machine-readable Phase 1 / Phase 2 package-boundary diagnosis against a hash-pinned historical 71-entry / 59-tool package; it does not inject the Phase 1 candidate into Phase 2's exact-inventory acceptance test, suppress an assertion, trim archive entries, or change the frozen contract.

The pack verifier independently re-hashes all manifest-listed evidence files, validates the complete `SHA256SUMS.txt` inventory (including a final inventory-race check), rejects unlisted files and duplicate-key JSON, verifies the full command ledger and raw output sidecars, recomputes source snapshot patch/overlay/transport-archive hashes, rejects ambiguous/non-regular TAR entries, verifies retained excluded protocol docs and actually reconstructs the source in a clean detached clone, re-runs source-to-binary alignment against the captured candidate bytes, cross-checks the Phase 2 boundary diagnosis, and confirms readiness keeps execution/release closed. Its complete evidence-tree snapshot also binds file and directory device/inode, size, mode, owner/group, modification/change timestamps and canonical paths at both verification boundaries, so same-byte inode replacement, directory substitution, symlink insertion, and inventory drift fail closed rather than passing a path/hash-only check. Use four separate result classes when reporting this work: `VERIFIED` is reserved for independently rerun local assertions; `INTEGRITY_ONLY` means byte/provenance/ledger self-consistency without operational acceptance; `BLOCKED` identifies a failed or unavailable prerequisite; `ACCEPTANCE_REQUIRED` means an authorized owner/reviewer/evaluator decision and operational evidence are still needed. Successful evidence-pack verification is `PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE`; it does not establish trusted approval or operational acceptance. The frozen scenario spec remains `prepared-not-authorized`; no operational A/B is started without separate recorded one-shot gate consumption, trusted owner authorization, the approved ten-scenario corpus, independent review/adjudication and current isolation attestations. The pipeline never runs the ten operational scenarios or modifies trust roots, frozen specs, candidate history, or `dist/`.
