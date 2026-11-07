# Runalith scripts — inventory and classification

**Scan date:** 2026-10-30
**Scope:** every regular file under `scripts/`, including nested `lib/`, `tools/` and `templates/`.
**Checkout observed:** branch `main`, HEAD `6b7bc90a8b16e50be9c7331c0b2f6361cc40b8f3`.
**Purpose:** navigation and operational-risk classification. This is a source review, not a certification that every script is safe, current, or appropriate for production.

## 1. Scan summary

| Location / kind | Files |
|---|---:|
| `scripts/` root | 72 |
| `scripts/lib/` reusable implementation modules | 8 |
| `scripts/tools/` source patch helpers | 4 |
| `scripts/templates/` site template | 1 |
| **Total** | **85** |

By extension: 50 `.mjs`, 17 `.js`, 12 `.sh`, 3 `.py`, 1 `.cjs`, 1 `.json`, and 1 `.html`.

The directory is not a single uniform command suite. It contains current Runalith/AGG tooling, packaging and evidence validators, worker/runtime adapters, historical RC.5 replay scripts, and an older ChatGPT Web multi-account adapter toolchain. Several files are helper modules or data assets rather than directly runnable commands.

## 2. Effect and risk legend

The tags describe the effect of running a script as currently written. They are not a security guarantee.

| Tag | Meaning |
|---|---|
| **R0 — source/read-only** | Reads source or supplied evidence and prints a result; no intended persistent write. |
| **R1 — state inspection** | Reads a local SQLite DB, host process metadata, installed package, or sensitive evidence. Treat output as potentially sensitive. |
| **OUT — new output** | Creates a new report, corpus, benchmark, sidecar, or evidence directory. Usually refuses to overwrite, but verify the exact output path. |
| **TEMP — isolated execution** | Creates temporary files, DBs, extracted bundles, clones, or local subprocesses which should be cleaned up. This is not the same as a sandbox for arbitrary packaged code. |
| **BUILD — package/site write** | Writes generated site content, staging files, or an MCPB candidate. It does not imply installation or activation. |
| **LIVE — active local service/UI** | Connects to a running local adapter, Chrome CDP, or current desktop profile; may expose conversation data or change live state. |
| **TASK — workflow/worker action** | Can create, approve, dispatch, run or complete real workflow/task/lease operations, or make a credentialled provider call. Requires an explicitly isolated test/runtime context and authorization. |
| **HOST — process control** | Starts, stops, kills, or restarts host processes, browser profiles, or daemons. |
| **AUTHORITY — external security mutation** | Can advance an external checkpoint or otherwise mutate a security authority. Explicit flags and separately authorized inputs are required. |
| **EDIT — in-place source edit** | Modifies a source file directly. Review the diff and target path before any use. |

**Important distinction:** a verifier or a locally generated receipt can establish byte correspondence or validate supplied signatures. It cannot create independent trust, authenticate its own inputs, prove production deployment, or turn local hashes/SQLite state into external authority.

## 3. Current AGG/V2 diagnostics, planning and remediation

| File | Classification | Effect / use |
|---|---|---|
| [`audit-agg-v2-event-callers.mjs`](../scripts/audit-agg-v2-event-callers.mjs) | AGG V2 source inventory | **R0 / OUT** — statically discovers supported `recordEvent()` member-call expressions in the configured entrypoint and `src/runtime`; optional JSON output. Narrow lexical scan, not an AST or complete event registry. |
| [`capture-agg-v2-disposable-db-contract.mjs`](../scripts/capture-agg-v2-disposable-db-contract.mjs) | AGG V2 SQLite harness | **TEMP / OUT** — imports the source WorkflowStore and trust-ledger initializer against private temporary DBs, reads connection PRAGMAs, reopens the files and compares schema digests. It does not open a user/production DB. |
| [`run-agg-v2-local-preflight.mjs`](../scripts/run-agg-v2-local-preflight.mjs) | AGG V2 developer preflight | **TEMP / OUT** — combines the event scanner, disposable DB harness, docs check, `git diff --check`, and an explicit whitespace scan of selected new files. `docs:check` starts an isolated local source MCP process for `initialize`/`tools/list`; it does not connect to the installed host instance or invoke workflow tools. |
| [`build-agg-live-remediation-plan.mjs`](../scripts/build-agg-live-remediation-plan.mjs) | AGG remediation-plan generator | **R1 / OUT** — reads supplied dossier/reconciliation/preflight inputs and writes a remediation plan. It does not execute repairs or mutate workflow state. |
| [`build-agg-readiness-dossier.mjs`](../scripts/build-agg-readiness-dossier.mjs) | AGG readiness dossier generator | **R1 / OUT** — consolidates supplied alignment, reconciliation, preflight, snapshot and trust-status evidence into a dossier. It is an evidence aggregator, not a gate-closing operation. |
| [`reconcile-active-workflows.mjs`](../scripts/reconcile-active-workflows.mjs) | Workflow + Goal/Idea diagnostics, first generation | **R1 / OUT** — opens a SQLite DB read-only and reports active workflow/task lineage and AGG graph/evidence diagnostics. Use an explicit `--db`; `--include-sensitive-source-identifiers` can disclose historical `file:` references and digests. No recovery is attempted; age/missing lease is not proof of worker death. |
| [`reconcile-active-workflows-v2.mjs`](../scripts/reconcile-active-workflows-v2.mjs) | Workflow diagnostics, V2 reconciliation | **R1 / OUT** — read-only DB diagnostics with V2 provider-run/lease and event-lineage classifications. Use an explicit `--db`; report output may contain operational identifiers. It does not repair, retry, cancel or recover work. |
| [`verify-agg-acceptance-consistency.mjs`](../scripts/verify-agg-acceptance-consistency.mjs) | Cross-artifact acceptance consistency checker | **R1** — compares supplied candidate/evidence/readiness inputs and archive metadata for internal consistency. A consistency PASS is not independent provenance or external trust. |

## 4. AGG algorithm, planning-shadow and benchmark tools

| File | Classification | Effect / use |
|---|---|---|
| [`benchmark-agg-phase2-paired.mjs`](../scripts/benchmark-agg-phase2-paired.mjs) | Phase 1 vs Phase 2 paired benchmark | **R0 / OUT** — reads caller-supplied corpus/model, performs offline paired search/benchmark trials and writes a new result artifact. Synthetic/caller-supplied metrics are diagnostic, not acceptance evidence. |
| [`benchmark-agg-phase3-mcts-vs-beam.mjs`](../scripts/benchmark-agg-phase3-mcts-vs-beam.mjs) | Phase 2 beam vs Phase 3 MCTS benchmark | **R0 / OUT** — bounded repeated-seed offline comparison using supplied graph/dataset/model/corpus and output path. It does not execute proposed actions. |
| [`benchmark-p10-capacity.js`](../scripts/benchmark-p10-capacity.js) | P10 scheduler capacity microbenchmark | **R0** — uses an in-memory fake store/provider harness with simulated delays. It does not benchmark a real provider, worker pool, or production DB. |
| [`create-agg-phase3-adversarial-corpus.mjs`](../scripts/create-agg-phase3-adversarial-corpus.mjs) | Synthetic adversarial corpus builder | **OUT** — creates a deterministic synthetic corpus for technical regression. The corpus is not owner-signed, independently adjudicated, or operational evidence. |
| [`evaluate-agg-phase2-discriminator.mjs`](../scripts/evaluate-agg-phase2-discriminator.mjs) | Phase 2 model evaluator | **R0 / OUT** — evaluates a supplied discriminator model against dataset splits and writes an evaluation artifact; does not modify the model or execute plans. |
| [`run-agg-phase2-shadow-search.mjs`](../scripts/run-agg-phase2-shadow-search.mjs) | Phase 2 shadow search | **R0 / OUT** — performs bounded graph search and writes a shadow proposal/result. The output is not an executable workflow or approval. |
| [`run-agg-phase2-workflow.mjs`](../scripts/run-agg-phase2-workflow.mjs) | Offline Phase 2 evidence workflow | **OUT / TEMP** — runs train → holdout evaluation → paired benchmark → shadow search → replay verification, and captures working-tree/source identities into a new output directory. Can consume substantial CPU/disk and records the current checkout state; output must be a new directory. |
| [`run-agg-phase3-evidence-pack.mjs`](../scripts/run-agg-phase3-evidence-pack.mjs) | Phase 3 evidence-pack runner | **OUT / TEMP** — runs Phase 2/3 integration, docs/security/full-test and repeated-seed benchmark commands, then writes an immutable evidence pack and derived sidecars. High CPU/disk/time cost; does not sign or release a candidate. |
| [`run-agg-phase3-mcts-shadow.mjs`](../scripts/run-agg-phase3-mcts-shadow.mjs) | Phase 3 MCTS shadow search | **R0 / OUT** — validates supplied graph/dataset/model and training identity, runs bounded UCT/MCTS, and writes a shadow result. No plan execution or readiness transition. |
| [`train-agg-phase2-discriminator.mjs`](../scripts/train-agg-phase2-discriminator.mjs) | Phase 2 discriminator trainer | **R0 / OUT** — trains from supplied dataset splits and writes a model artifact. It does not establish independent label provenance or acceptance. |
| [`verify-agg-phase2-workflow.mjs`](../scripts/verify-agg-phase2-workflow.mjs) | Phase 2 workflow artifact verifier | **R1 / OUT** — independently checks the dataset/model/evaluation/graph/shadow/corpus/benchmark artifacts plus current source/worktree identity; writes a report. Verification is limited to the supplied pack and local source bytes. |

## 5. Trust, custody, source identity and release verification

| File | Classification | Effect / use |
|---|---|---|
| `scripts/capture-phase2-working-tree-identity.mjs` | Source/worktree identity capture | **R1 / OUT** — records Git HEAD, tracked patch and untracked source inventory plus optional candidate/evidence references. Output can disclose paths and source hashes; it is not an authenticated build receipt. |
| [`check-agg-phase3-source-drift.mjs`](../scripts/check-agg-phase3-source-drift.mjs) | Phase 3 pack/source drift check | **R1 / OUT** — compares an immutable pack/source snapshot to the current checkout and writes a derived source-drift receipt. A local receipt is not an external signature or approval. |
| [`create-hosted-candidate-verification-predicate.mjs`](../scripts/create-hosted-candidate-verification-predicate.mjs) | Hosted verification-predicate constructor | **R1 / OUT** — constructs a predicate from supplied candidate, policy and verification inputs. This script does not independently authenticate the builder or sign the predicate; treat it as derived local data. |
| [`diagnose-phase2-archive-lineage.mjs`](../scripts/diagnose-phase2-archive-lineage.mjs) | Historical archive/source lineage diagnosis | **R0** — compares archive contents with Git/source objects and prints correspondence. A matching Git blob/commit does not prove builder identity, approval or clean provenance. |
| [`runalith-rollout.mjs`](../scripts/runalith-rollout.mjs) | Release/rollout readiness CLI | **R1 / OUT / TEMP / AUTHORITY (optional)** — `preflight` and `verify-installed` are read-only by default; `backup-installed` writes a new backup/manifest under `/tmp`; `simulate` uses a temporary generation directory. **Only** `preflight --advance-external-checkpoint` is an explicit external security-store mutation, consuming a single-use nonce. The CLI does not install or activate a plugin. Never add that flag as a diagnostic shortcut. |
| [`validate-agg-trust-config.mjs`](../scripts/validate-agg-trust-config.mjs) | Trust configuration validator | **R1** — validates supplied admin trust configuration, domain separation and optionally compares it with a process environment read from `/proc`. It does not establish trust-ledger high-water continuity or an external checkpoint. Process-environment inspection is not host attestation. |
| [`verify-agg-phase1-evidence-pack.mjs`](../scripts/verify-agg-phase1-evidence-pack.mjs) | Phase 1 evidence-pack verifier | **R1 / TEMP / OUT** — validates the pack and source snapshot, extracts/replays selected checks and may reconstruct a temporary Git workspace. It writes a report; it is not a production approval. |
| [`verify-agg-phase1-phase2-package-boundary.mjs`](../scripts/verify-agg-phase1-phase2-package-boundary.mjs) | Phase 1/Phase 2 archive boundary verifier | **R1 / OUT** — compares archive entry/path contracts and optional reference package; may write a report. Does not prove custody of the reference archive. |
| [`verify-agg-phase2-evidence-pack.mjs`](../scripts/verify-agg-phase2-evidence-pack.mjs) | Phase 2 evidence-pack verifier | **R1 / TEMP / OUT** — checks manifest/inventory/source, receipts and replay; writes a report and uses temporary replay material. Trusted-anchor verification requires an expected digest from a separate trusted channel, a valid Ed25519 signature and an out-of-band configured key. A self-computed digest is not an anchor. |
| [`verify-agg-phase3-evidence-pack.mjs`](../scripts/verify-agg-phase3-evidence-pack.mjs) | Phase 3 evidence-pack verifier | **R1 / TEMP / OUT** — verifies manifest/source/artifact/log hashes and can replay deterministic benchmark/runner checks in temporary paths. An independent anchor still requires a separately provisioned public key/signature. |
| [`verify-hosted-builder-provenance.mjs`](../scripts/verify-hosted-builder-provenance.mjs) | Hosted builder attestation verifier | **R1 / OUT** — verifies supplied candidate and builder attestation bundle against source commit and expected builder contract; optional output report. Depends on independently provisioned trust roots and the integrity of supplied evidence. |
| [`verify-mcpb-source-alignment.mjs`](../scripts/verify-mcpb-source-alignment.mjs) | MCPB/source byte-alignment verifier | **R1 / TEMP / OUT** — inspects archive entries and compares candidate bytes to the configured source/build-input set; may create a temporary extraction/snapshot and optional report. Byte alignment is not authenticated build provenance. |
| [`verify-phase2-custody-evidence.mjs`](../scripts/verify-phase2-custody-evidence.mjs) | Phase 2 custody signature/inventory verifier | **R1** — checks supplied manifest, builder receipt, keys, identity and candidate binding. It cannot create the missing owner-signed manifest or independent builder receipt. |
| [`verify-release-evidence.mjs`](../scripts/verify-release-evidence.mjs) | Release DSSE/evidence verifier | **R1** — checks supplied release policy, provenance, verification, approval, nonce, candidate and rollback/baseline bindings. A local verification result does not authorize activation or substitute for host trust policy. |

## 6. Documentation, static site and MCPB packaging

| File | Classification | Effect / use |
|---|---|---|
| [`build-static-site.mjs`](../scripts/build-static-site.mjs) | Static-site generator | **BUILD** — renders the site template and overwrites `site/index.html`. Review generated changes before retaining them. |
| [`check-docs.mjs`](../scripts/check-docs.mjs) | Documentation/link/MCP-reference checker | **R0 / TEMP / NETWORK (optional)** — checks Markdown and local links; runs MCP-reference parity through a private local source-process launch. The external-link option performs HTTP requests. No production DB should be touched; the checker explicitly tests that inherited DB/workspace overrides are replaced. |
| [`check-static-site.mjs`](../scripts/check-static-site.mjs) | Static-site validator | **R0 / NETWORK (optional)** — checks generated site assets, links and required release-status wording. `--check-external-links` issues HTTP HEAD/GET requests to external sites. |
| [`collect-plugin-runtime.mjs`](../scripts/collect-plugin-runtime.mjs) | Package runtime collector | **OUT / BUILD** — copies the configured runtime dependency closure into a caller-supplied staging directory. Does not edit source but writes stage files. |
| [`generate-mcp-reference.mjs`](../scripts/generate-mcp-reference.mjs) | MCP reference generator | **TEMP / BUILD** — starts the configured local source entrypoint with isolated temporary paths and queries `initialize`/`tools/list`; normal mode writes `docs/MCP_REFERENCE.md`, while `--check` compares without updating the reference. It is not a live-host interrogation. |
| [`mcpb-tools.mjs`](../scripts/mcpb-tools.mjs) | Direct tools client for a local MCPB | **TEMP / TASK (conditional)** — extracts/launches a bundle with isolated DB, workspace and HOME; default name heuristic blocks side-effect-like tools. `--allow-tool` and `--allow-side-effects` explicitly permit calls. This is **not a sandbox** and cannot constrain arbitrary code inside the bundle. Use only on a trusted candidate and isolated inputs. |
| [`package-runalith-mcpb.sh`](../scripts/package-runalith-mcpb.sh) | MCPB candidate packager | **BUILD / TEMP** — creates a new `.mcpb`, validates source alignment and launches an isolated package smoke. Default output is under `dist/`; it does not install or activate the candidate. Preserve frozen archives and select a new output path. |
| [`plugin-package-metadata.mjs`](../scripts/plugin-package-metadata.mjs) | Package metadata projection helper | **R0** — pure helper projecting repository `package.json` into the minimal MCPB dependency-closure metadata. Not a CLI. |
| [`render-doc-diagrams.sh`](../scripts/render-doc-diagrams.sh) | Archify diagram renderer | **BUILD** — writes rendered HTML/PNG files beneath `docs/diagrams/rendered/` and timestamped receipts beneath `docs/diagrams/receipts/`. It requires an installed Archify CLI. |
| [`test-mcpb-candidate.mjs`](../scripts/test-mcpb-candidate.mjs) | MCPB isolated smoke test | **TEMP** — extracts the candidate, launches its packaged entrypoint with isolated state and checks initialization/tool listing/health. It does not install the bundle. A package can still execute its own startup code inside that process; use trusted inputs. |

## 7. Desktop, local-service, worker and legacy E2E scripts

This group is **not part of the configured RC.71 entrypoint contract by virtue of living in `scripts/`**. Several files target historical `server.js`, `job-store.js`, `coordinator-workflow.js`, ports `8318`/`9021`, or native OpenClaw. Do not use them interchangeably with the current versioned MCP server.

| File | Classification | Effect / use |
|---|---|---|
| [`login-account.sh`](../scripts/login-account.sh) | Legacy desktop account login helper | **LIVE / HOST** — launches Chrome with one of four persistent user-data profiles. Login cookies/session data remain on disk. Not part of RC.71 deployment. |
| [`probe-deep.js`](../scripts/probe-deep.js) | Chrome CDP conversation inspection | **LIVE / R1** — connects to CDP port `9021`, reads the current tab DOM, assistant content/model/busy indicators and prints a result. Output may contain private conversation content. |
| [`probe-insert.js`](../scripts/probe-insert.js) | Chrome CDP composer input probe | **LIVE / HOST** — inserts test text into the currently selected ChatGPT composer. It does not intentionally press Send, but it changes the live UI. |
| [`probe-model.js`](../scripts/probe-model.js) | Chrome CDP model/busy-state inspection | **LIVE / R1** — reads current tab model picker and assistant state; output may expose UI metadata. |
| [`probe-msgs.js`](../scripts/probe-msgs.js) | Chrome CDP message inspection | **LIVE / R1** — reads the current tab's recent user/assistant message text and image alt labels; potentially sensitive output. |
| [`probe-tab.js`](../scripts/probe-tab.js) | Chrome CDP tab/DOM inspection | **LIVE / R1** — reads composer, send/stop buttons, dialogs and banners on the selected tab. |
| [`run-adapter-loop.sh`](../scripts/run-adapter-loop.sh) | Legacy adapter restart loop | **HOST** — loops forever launching `node server.js` and appending to `adapter.log`. It can repeatedly restart a legacy server and is not the RC.71 versioned entrypoint. |
| [`run-ephemeral-openclaw-node.js`](../scripts/run-ephemeral-openclaw-node.js) | Ephemeral OpenClaw node bootstrap | **HOST / CREDENTIALLED / TEMP** — consumes `OPENCLAW_BOOTSTRAP_CREDENTIAL`, writes a short-lived mode-0600 target file, invokes `openclaw connect --ephemeral`, then removes the temporary directory. Use only with a legitimate one-shot credential and intended target. |
| [`run-m11-native-e2e.js`](../scripts/run-m11-native-e2e.js) | M11 local native-runner E2E | **TEMP / TASK (test-only)** — launches historical `server.js` on a random loopback port with a fresh temporary DB/workspace and mock runner, sends local workflow API requests, then removes the temporary directory. It is not a production-host test and the entrypoint differs from RC.71. |
| [`run-m4-e2e.js`](../scripts/run-m4-e2e.js) | M4 OpenClaw/workflow E2E | **LIVE / TASK** — uses the imported `workflowStore`, local OpenClaw CLI and workflow API to create/approve/execute a workflow; the scenario asks an engineer to write a workspace file. Do not run against the ordinary user DB/workspace. Only run with a fully isolated DB, workspace, OpenClaw profile and explicit test authorization. |
| [`run-p13-failure-injection.js`](../scripts/run-p13-failure-injection.js) | P13 failure-injection test wrapper | **TEMP / TASK (test-only)** — launches `tests/test-p13-failure-injection.js` in child mode for selected failure modes. Intended for the test suite; inspect the child test's DB/temp isolation before running in a non-test checkout. |
| [`run-v26.js`](../scripts/run-v26.js) | Legacy v26 workflow E2E trigger | **LIVE / TASK** — POSTs to `127.0.0.1:8318/v1/chat/completions`; the script includes both proposal and approval-turn instructions and may trigger actual local adapter workflow/task activity. Not a read-only diagnostic. |
| [`run-v26-continue.js`](../scripts/run-v26-continue.js) | Legacy v26 continuation trigger | **LIVE / TASK** — sends a continuation/approval message to the existing adapter on port `8318`; can advance existing workflow state. |
| [`run-v27-e2e.js`](../scripts/run-v27-e2e.js) | Legacy v27 native E2E | **LIVE / TASK** — imports a legacy `workflowStore`, calls OpenClaw and inspects task/report lineage. It can create and advance durable jobs in whichever DB the imported store opens. |
| [`run-worker-task.js`](../scripts/run-worker-task.js) | Hosted worker task executor | **TASK / CREDENTIALLED / OUT** — consumes provider-run/lease/task identity from required environment variables, validates the task payload and workspace scopes, runs assigned commands/runner logic and writes evidence files. Intended for the authorized GitHub runner path, not manual local execution. |
| [`runner-agent-openclaw.js`](../scripts/runner-agent-openclaw.js) | OpenClaw agent backend for runner task | **TASK / CREDENTIALLED / TEMP** — requires `OPENAI_API_KEY`, writes temporary agent config/task input and invokes OpenClaw with a full tool profile in the runner workspace. It can inspect or modify the checked-out repository depending on the task. |
| [`start.sh`](../scripts/start.sh) | Legacy desktop/adapter starter | **HOST** — starts Xvfb, up to four Chrome profiles with remote-debugging ports and `node server.js` on port `8318`. It launches browsers with `--no-sandbox`; not the RC.71 MCP host start command. |
| [`stress-test-coordinator.js`](../scripts/stress-test-coordinator.js) | Legacy in-memory coordinator stress test | **R0** — exercises an old coordinator FSM in memory. It imports `coordinator-workflow.js` and does not validate the current RC.71 MCP runtime. |
| [`stress-test.js`](../scripts/stress-test.js) | Legacy live multi-account adapter load test | **LIVE / TASK** — sends repeated chat-completion requests to `127.0.0.1:8318`, reads account pool status and can affect live rate limits, usage and workflow state. Do not run as a harmless unit test. |
| [`watchdog.sh`](../scripts/watchdog.sh) | Legacy process watchdog/recovery | **HOST / LIVE** — checks port `8318`, can `pkill -f "node server.js"`, start Xvfb/Chrome and restart `server.js`. High-impact host process control; do not run without explicit operational authorization. |

## 8. Historical evidence replay scripts

| File | Classification | Effect / use |
|---|---|---|
| [`replay-agg-devloop-validation.mjs`](../scripts/replay-agg-devloop-validation.mjs) | Extracted-pack development validation replay | **OUT / TEMP** — requires an explicit environment guard and a fresh extracted pack without `.git/` or `dist/`; runs validations and writes derived outputs, including cleanup of one generated inventory file before rerunning its builder. Do not run in the source checkout. |
| [`replay-agg-phase1-finalization.mjs`](../scripts/replay-agg-phase1-finalization.mjs) | Phase 1 evidence finalization/replay | **OUT / BUILD / TEMP** — captures full working-tree identity, runs focused and full tests/docs/package checks, may build and smoke-test an MCPB, then writes a new evidence directory. High disk/CPU cost; the output is derived local evidence, not approval. Must use a new output directory outside `dist/`. |
| [`replay-provenance-benchmark-successor10.sh`](../scripts/replay-provenance-benchmark-successor10.sh) | Historical RC.5 successor10 replay | **OUT / TEMP / LEGACY** — checks fixed RC.5 candidate digests and runs a hard-coded test/replay matrix in an extracted evidence pack. Not for the current checkout or active RC.71 candidate. |
| [`replay-provenance-benchmark-successor11.sh`](../scripts/replay-provenance-benchmark-successor11.sh) | Historical RC.5 successor11 replay | **OUT / TEMP / LEGACY** — successor11-specific fixed bundle digests and validation matrix; use only against its matching fresh extraction. |
| [`replay-provenance-benchmark-successor12.sh`](../scripts/replay-provenance-benchmark-successor12.sh) | Historical RC.5 successor12 replay | **OUT / TEMP / LEGACY** — successor12-specific evidence replay and expected blocker checks. Not current release evidence. |
| [`replay-provenance-benchmark-successor13.sh`](../scripts/replay-provenance-benchmark-successor13.sh) | Historical RC.5 successor13 replay | **OUT / TEMP / LEGACY** — verifies exact historical official/dev package hashes, runs a test matrix and writes replay logs. Requires its matching extracted pack. |
| [`replay-provenance-benchmark-successor14.sh`](../scripts/replay-provenance-benchmark-successor14.sh) | Historical RC.5 successor14 replay | **OUT / TEMP / LEGACY** — successor14-specific digest-pinned replay, tests and expected blockers. Requires its matching extracted pack. |
| [`replay-provenance-benchmark-successor15.sh`](../scripts/replay-provenance-benchmark-successor15.sh) | Historical RC.5 successor15 replay | **OUT / TEMP / LEGACY** — latest of this historical replay family; initializes a temporary bare Git metadata directory outside the extraction and runs security/recovery/package checks. It explicitly avoids the action-invoking full E2E and package builder. Still not current RC.71 acceptance evidence. |

## 9. Reusable modules under `scripts/lib/`

These are imported implementation modules, not standalone commands. Their behavior depends on the caller and supplied inputs.

| File | Responsibility | Effect boundary |
|---|---|---|
| [`lib/agg-phase2-evidence-receipts.mjs`](../scripts/lib/agg-phase2-evidence-receipts.mjs) | Validates expected Phase 2 checksum paths and whether verifier/source-drift receipts bind to the expected pack and manifest. | Pure validation helper; does not create an independent receipt. |
| [`lib/agg-phase2-independent-search-audit.mjs`](../scripts/lib/agg-phase2-independent-search-audit.mjs) | Independently re-derives Phase 2 search behavior and canonical reference results. | CPU-only computation over supplied graph/model data; not an operational authority. |
| [`lib/external-trust-checkpoint-contract.mjs`](../scripts/lib/external-trust-checkpoint-contract.mjs) | Defines canonical external checkpoint payload/digest and validates response contract fields. | Contract/cryptographic validation only; it does not contact or operate an external authority. |
| [`lib/hosted-builder-attestation.mjs`](../scripts/lib/hosted-builder-attestation.mjs) | Validates hosted builder evidence/attestation binding to candidate and source. | Signature/evidence verifier; relies on externally trusted policy/keys. |
| [`lib/hosted-verification-predicate.mjs`](../scripts/lib/hosted-verification-predicate.mjs) | Validates hosted build policy and constructs/digests candidate-verification predicate data. | Predicate construction is not a signature or independent verifier decision. |
| [`lib/phase2-custody-evidence.mjs`](../scripts/lib/phase2-custody-evidence.mjs) | Verifies Phase 2 manifest and builder receipt contracts, signatures, candidate path/hash binding and identity. | Verification helper only; cannot manufacture owner authority or an authentic builder receipt. |
| [`lib/runalith-release-trust-contract.mjs`](../scripts/lib/runalith-release-trust-contract.mjs) | Validates release policy and DSSE/in-toto/SLSA provenance, candidate verification and release approval envelopes. | Offline signature/policy verification; trusted roots and signed source inputs must come from outside this module. |
| [`lib/sqlite-external-checkpoint-transition.mjs`](../scripts/lib/sqlite-external-checkpoint-transition.mjs) | Declares SQLite transition schema and operations for a local checkpoint transition state machine. | **DB-WRITE IF CALLED** — functions operate on a caller-supplied SQLite connection; module presence is not production integration, external custody or monotonic authority. |

## 10. Source patch helpers under `scripts/tools/`

These are old direct-edit utilities, not part of the approved RC.71 source pipeline. All four can write source files in place. **Do not run them against the current checkout or a frozen candidate.**

| File | Behavior | Effect boundary |
|---|---|---|
| `scripts/tools/patch_by_lines.py` | Locates a hard-coded block in `work/chatgpt-adapter/server.js` and replaces a line range if its markers match. | **EDIT** — direct file rewrite; path is relative to current working directory. |
| `scripts/tools/patch_clean_adapter.py` | Applies hard-coded string substitutions and helper insertion in `/home/long/work/chatgpt-adapter/server.js`. | **EDIT** — direct absolute-path rewrite; does not use a patch review workflow. |
| `scripts/tools/patch_server.py` | Regex-replaces a hard-coded block in `work/chatgpt-adapter/server.js` if exactly one match exists. | **EDIT** — direct file rewrite; path is relative to current working directory. |
| `scripts/tools/update-server.cjs` | Applies a hard-coded text replacement to `work/chatgpt-adapter/server.js`. | **EDIT** — direct file rewrite; path is relative to current working directory. |

## 11. Data/template assets under `scripts/`

| File | Type | Responsibility / effect |
|---|---|---|
| [`runalith-hosted-build-policy.json`](../scripts/runalith-hosted-build-policy.json) | JSON policy input, not executable | Declares the hosted build policy contract, repository/workflows, OIDC issuer, predicate types and required checks. It is a policy data file; its presence in the source tree does not make it host-pinned or independently trusted. |
| `scripts/templates/site-index.html` | HTML build template | Input to `build-static-site.mjs`; not a standalone command. Changes flow into generated `site/index.html` when the builder is run. |

## 12. npm script exposure

Only a small subset of `scripts/` files is directly wired to `package.json` scripts at this scan:

| npm command | File | Notes |
|---|---|---|
| `npm run docs:generate-reference` | `generate-mcp-reference.mjs` | Normal mode writes `docs/MCP_REFERENCE.md`; `--check` mode is comparison-only. |
| `npm run docs:check` | `check-docs.mjs` | Local docs/link/MCP-reference check. |
| `npm run docs:check:external` | `check-docs.mjs --check-external-links` | Adds outbound HTTP requests to external links. |
| `npm run site:check` | `check-static-site.mjs` | Checks existing generated site; add external-link option only when network checking is intended. |
| `npm run mcpb:tools` | `mcpb-tools.mjs` | Direct MCPB tools client; tool-call safety controls apply. |
| `npm run test:mcpb-candidate -- <candidate.mcpb>` | `test-mcpb-candidate.mjs` | Starts candidate in isolated temporary state; does not install it. |
| `npm run pack:runalith-mcpb` | `package-runalith-mcpb.sh` | Produces a validated MCPB candidate. |
| `npm run verify:mcpb-source-alignment` | `verify-mcpb-source-alignment.mjs` | Source/archive byte-alignment report. |
| `npm run agg:phase1:replay -- --output-dir <new-dir>` | `replay-agg-phase1-finalization.mjs` | Heavy evidence finalization; captures current checkout and may package/smoke a candidate. |
| `npm run agg:phase1:verify-evidence -- --evidence-dir <dir> --source-root <dir>` | `verify-agg-phase1-evidence-pack.mjs` | Evidence-pack verifier/replay. |
| `npm run validate:agg-trust-config -- ...` | `validate-agg-trust-config.mjs` | Trust configuration validation; not a host attestation or external checkpoint verifier. |

Other commands are manually invoked or imported as helpers. The absence of an npm alias is not a safety control; inspect the script before running it.

## 13. Recommended navigation and guardrails

For the current AGG external-checkpoint V2 work, the lowest-risk recurring local entrypoint is:

```sh
node scripts/run-agg-v2-local-preflight.mjs
```

For current workflow state inspection, prefer the read-only reconciliation tools with an explicit DB path:

```sh
node scripts/reconcile-active-workflows.mjs --db <explicit-read-only-db-path> --out <new-report.json>
node scripts/reconcile-active-workflows-v2.mjs --db <explicit-read-only-db-path> --out <new-report.json>
```

Before running any other command, confirm its target database/workspace, entrypoint, candidate, output path, network boundary and side-effect class. In particular:

1. Do not run `watchdog.sh`, `start.sh` or `run-adapter-loop.sh` as part of RC.71 work; they control legacy `server.js`/Chrome processes.
2. Do not run `run-v26*`, `run-v27-e2e.js`, `run-m4-e2e.js`, `stress-test.js`, `run-worker-task.js` or `runner-agent-openclaw.js` without explicit isolated runtime and task authorization.
3. Do not run `mcpb-tools.mjs` with side effects enabled on an untrusted bundle; the name-based guard is not a sandbox.
4. Do not run `scripts/tools/*` patchers on this checkout or a frozen source/archive.
5. Do not run historical successor10–15 or extracted-pack replay scripts from the current source checkout. Use only their exact matching fresh extracted evidence pack.
6. Never pass `--advance-external-checkpoint` to `runalith-rollout.mjs` unless a separate owner/host authorization explicitly permits that one-time external state transition after all prerequisite gates are proven.
7. Preserve candidate archives, signed manifests, receipts and prior evidence outputs as immutable. Use a new output path/directory for every generated report or pack.

## 14. Scan limitations

The inventory was derived from the current directory tree, package script references, entrypoint/CLI usage, imports and static inspection of write/process/network/SQLite callsites. It does not execute every command, discover dynamic imports/aliases or every transitive effect, prove that old scripts are still functional, or establish host deployment reachability. Optional flags and environment variables can change effects. A command marked `R0`, `R1` or `TEMP` is classified from its current code path and must still be reviewed with its actual inputs before execution.

**Inventory status:** 85/85 regular files in `scripts/` are listed above. No operational, worker, desktop, replay, package-build or host-mutating script was executed to perform the inventory. After writing the document, `npm run docs:check` was run as validation; it performs its documented isolated local source-process `initialize`/`tools/list` check. No repository runtime source, configured user database, installed plugin, host process or external authority was changed by this inventory task.
