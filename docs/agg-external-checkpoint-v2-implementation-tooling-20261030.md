# AGG external checkpoint v2 — local implementation tooling

**Status:** Developer enablement for source-level V2-01/V2-08 work. These commands do not close an issue, authorize a migration, prove deployment state, or change production readiness. The source-audit and preflight tools are invoked directly with `node`; the exact historical RC.23-to-RC.71 compatibility regression is also exposed as `npm run test:agg-rc23-migration` for repeatable local acceptance.

**Related:** [Decision register](agg-external-checkpoint-v2-decision-register-20261030.md), [normative specification](agg-external-checkpoint-v2-normative-spec-20261030.md), [current source inventory v0.12](agg-external-checkpoint-v2-projection-inventory-20261030-v0.12.md), [event query classification v0.3](agg-external-checkpoint-v2-event-query-classification-20261031-v0.3.md), [historical event query register v0.4](agg-external-checkpoint-v2-event-query-register-20261030-v0.4.json), [prior successor v0.5.1](agg-external-checkpoint-v2-event-query-register-20261030-v0.5.1.json), [prior successor v0.5.2](agg-external-checkpoint-v2-event-query-register-20261030-v0.5.2.json), [current event query register v0.5.4](agg-external-checkpoint-v2-event-query-register-20261031-v0.5.4.json), [historical recordEvent caller register v0.1](agg-external-checkpoint-v2-record-event-caller-register-20261030-v0.1.json), [prior successor v0.2](agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.2.json), [prior successor v0.3](agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.3.json), [current recordEvent caller register v0.5.6](agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.5.6.json), [preserved inventory v0.11](agg-external-checkpoint-v2-projection-inventory-20261030-v0.11.md), [preserved inventory v0.10](agg-external-checkpoint-v2-projection-inventory-20261030-v0.10.md), [preserved inventory v0.9](agg-external-checkpoint-v2-projection-inventory-20261030-v0.9.md), [preserved inventory v0.8](agg-external-checkpoint-v2-projection-inventory-20261030-v0.8.md), [preserved inventory v0.7](agg-external-checkpoint-v2-projection-inventory-20261030-v0.7.md), [authority dependency handoff](agg-v2-authority-dependency-handoff-20261030-v1.md), [production trust provisioning runbook](agg-production-trust-provisioning-runbook.md).

## 1. Command sequence

Run from the repository root. The tools do not connect to an installed/host MCP instance, GitHub, an external checkpoint, production trust, or any workflow/approval/task/lease operation. One nuance: `run-agg-v2-local-preflight.mjs` calls `scripts/check-docs.mjs`, which starts the configured source entrypoint as an isolated local subprocess for MCP `initialize` and `tools/list` documentation validation, using temporary paths. This is not the running host/server and does not invoke workflow tools.

### One-command local preflight

```sh
node scripts/run-agg-v2-local-preflight.mjs
```

The wrapper runs both event and direct-SQL scanner self-tests, writes a versioned direct-SQL source inventory, builds an in-memory event-caller report, runs fresh/restart disposable SQLite checks, runs the exact historical RC.23-to-RC.71 migration regression, runs focused SQL scanner tests, executes `scripts/check-docs.mjs`, checks trailing whitespace in reviewed scripts/docs/evidence (including untracked files), and runs `git diff --check`. It prints a JSON result. `PASS_LOCAL_CHECKS_WITH_EXTERNAL_GATES_OPEN` means only that those local checks passed; it is not an issue-acceptance or release result.

To keep a dated report, supply a new output path. The script uses exclusive-create semantics and will refuse to overwrite an existing path:

```sh
node scripts/run-agg-v2-local-preflight.mjs \
  --output artifacts/adaptive-goal-graph/agg-v2-local-preflight-YYYYMMDDTHHMMSSZ.json
```

Replace the timestamp placeholder with a new UTC timestamp before running.

### Event-writer callsite inventory

```sh
node scripts/audit-agg-v2-event-callers.mjs --self-test
node scripts/audit-agg-v2-event-callers.mjs
node scripts/audit-agg-v2-event-callers.mjs --json
node --test tests/test-agg-v2-event-callers.mjs
```

The checked-in recordEvent register freezes scanner-visible callsite paths/lines/arguments and source-file hashes, records source/data-flow notes for all 17 computed producer expressions, and explicitly leaves all 72 literal event types unclassified pending query-by-query review. It also records two observed direct SQL `INSERT INTO events` writers and three exact reader query/binding sites. The regression fails on scanner-visible source drift until the register is deliberately reviewed and versioned. This is not an event allowlist, projection manifest, runtime enforcement or proof of lexical scanner completeness/deployment reachability.

### Direct SQL mutation callsite inventory

```sh
node scripts/audit-agg-v2-sql-mutation-callers.mjs --self-test
node scripts/audit-agg-v2-sql-mutation-callers.mjs
node scripts/audit-agg-v2-sql-mutation-callers.mjs --output artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-YYYYMMDDTHHMMSSZ.json
node --test tests/test-agg-v2-sql-mutation-audit.mjs
node scripts/verify-agg-v2-authority-dependency-register.mjs
node --test tests/test-agg-v2-authority-dependency-register.mjs
```

The scanner records lexical direct `prepare()` / `exec()` callsites across the configured entrypoint, `src/runtime/` and `scripts/`. It deliberately reports dynamic SQL, CTE-prefixed statements and unclassified literals as unresolved. Counts do not prove projection membership or writer completeness; see inventory v0.7 §15.

The authority dependency register validator verifies the local handoff's schema, required owner-role/authority/decision/artifact/evidence/verification fields, issue-state observations and fail-closed flags. It does not query GitHub, verify an assigned person's identity, validate signatures, or create/verify external authority. See the [authority dependency handoff](agg-v2-authority-dependency-handoff-20261030-v1.md).

The scanner reads the configured `package.json` runtime entrypoint and recursively scans JavaScript files beneath `src/runtime`. The checked-in v0.1 register captured 88 source files, 116 `recordEvent()` callsites (99 literal, 17 computed), and 72 distinct literal event types. It records callsite path/line, event-type expression, literal classification, literal type set and SHA-256 identities for scanned source files. `--json` emits the full machine-readable report. Use `--output <new-path>` to save it with exclusive-create semantics.

The preserved 2026-10-30 v0.6 capture scanned **88 source files** and found **116 callsites in 8 callsite-bearing files**: 99 literal and 17 computed/unresolved callsites; 72 distinct literal event types. Historical evidence (not current register):

`artifacts/adaptive-goal-graph/rc71-record-event-callers-20261030T073526Z.json`

SHA-256: `ea5b947035c1d57c43046e2365235cff6511dd75d05d942ad16806e217cad462`.

The v0.6 scanner was a narrow lexical member-call scan and had known interpolation/multiline/regex limitations. The v0.12 regression now covers template interpolation, nested templates, multiline member syntax, optional calls, comments, CR/LF/CRLF and regex-literal contexts including `export default`. It remains lexical, not a JavaScript AST: aliases, destructuring, computed property names, imported wrappers, generated calls, runtime-built SQL, non-SQL event stores and deployed process reachability are not proven complete. All 17 computed producer expressions now have explicit source/data-flow notes; `WorkflowStore.transitionWorkflowPhase()` still accepts an unbounded caller-supplied event value, and optional-module deployment/shared-DB reachability remains unknown. All 72 literal event types remain unclassified pending query-by-query reader/writer review. The register is source discovery, not the normative event registry, complete projection, runtime process inventory, or a substitute for reconciling existing database rows.

The SQL mutation inventory and event register separately capture two currently observed direct `INSERT INTO events` writers outside `recordEvent()` and three reader query/binding sites for approval-policy high-water and reviewer attestation/nonce checks. The regression ties each direct `prepare()` to its adjacent `.run()` binding and pins exact query and parameter-binding lines. This is a bounded observation, not proof that every direct event mutation, alias, wrapper, dynamic SQL expression or other store has been found.

### Query-level event reader/writer classification

```sh
node scripts/build-agg-v2-event-query-register.mjs
node scripts/build-agg-v2-event-query-register.mjs \\
  --output docs/agg-external-checkpoint-v2-event-query-register-YYYYMMDD-vN.json
node --test tests/test-agg-v2-sql-mutation-audit.mjs
```

The checked-in v0.4 register classifies 193 runtime event SQL callsites across seven files: 189 readers, three event-row writers and one multi-statement schema/trigger bootstrap with no event-row DML. It records SQL predicates, literal/parameterized event types, WHERE-clause predicate columns, ordering, caller context and bounded transaction-marker evidence. Caller and transaction context are source-layout/brace-balance heuristics, not AST/control-flow proof. The companion classification note maps the observed approval/reviewer/nonce/execution-boundary/recovery readers and documents producer/query coverage deltas. All 193 `authorizationPurpose` fields remain pending semantic review; the register is not an event allowlist, projection manifest or deployed process inventory.

For this exact source revision, a second raw `rg -n -o 'recordEvent\s*\('` pass returned 117 textual hits. After excluding the method declaration at `src/runtime/job-store.js:1276`, every remaining path/line pair matched the scanner's 116 callsites; no extra or missing callsite lines were observed. This is a bounded cross-check of the current source shape, not a guarantee for aliases or other syntactic forms.

### 2026-10-31 source-drift successor (historical registers preserved)

The RC.71 approval/reviewer implementation changed two files already covered by historical source pins. The historical recordEvent register v0.1 and SQL inventory/query register v0.4 were not edited. Reviewed successors:

- RecordEvent inventory: `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T051500Z-v2.json`, SHA-256 `1e16f54662fb229f5b3ef63de033b19dea6184301655e60fe0f5411e190b43fc`. Its 88 source files and 116 callsites retain the same semantic callsite tuples as v0.1. Three configured-entrypoint callsites moved by two lines; no producer was added or removed. Register v0.2 pins current file hashes and line numbers.
- Direct SQL inventory: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261031T051500Z-v3.json`, SHA-256 `7cc2bd959ea064bf09eae972daa56e6ff7035cf7f1d37a197ff739f906af5986`. It scans 159 source files and 1,460 direct SQL callsites. Operation-class counts and 242 data-write callsites are unchanged from prior v2 inventory. New script files are included; configured server and reviewer-identity source hashes/line offsets changed, while their SQL callsite counts remain 165 and 10.
- Event query register v0.5.1: SHA-256 `3761f326c26b97c116df7845321cd19b64761eb16bb9819a1fb66ea9365dd5b5`. Its `sourceInventory` path and digest are cross-checked against the v3 artifact. It retains 193 event SQL callsites (189 readers, three writers, one schema-only bootstrap). It updates source hashes and line locations only; all `authorizationPurpose` values remain pending semantic review.

Reproduction for the query successor:

```sh
node scripts/audit-agg-v2-sql-mutation-callers.mjs --output artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-YYYYMMDDTHHMMSSZ-vN.json
node scripts/build-agg-v2-event-query-register.mjs --inventory artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-YYYYMMDDTHHMMSSZ-vN.json --register-id agg-v2-event-query-register-YYYYMMDD-vN --output docs/agg-external-checkpoint-v2-event-query-register-YYYYMMDD-vN.json
```

The builder records actual input path and digest. Regression copies selected inventory into a disposable root, introduces controlled configured-entrypoint drift, and proves unchanged runtime rows are reused byte-for-byte. Focused tests: `node --test tests/test-agg-v2-event-callers.mjs tests/test-agg-v2-sql-mutation-audit.mjs` — PASS 20/20. These source inventories do not establish complete call-graph coverage, event semantics, V2 projection membership, deployment reachability or external authority.

#### Plan Graph lifecycle patch source-drift successor — 2026-10-31

The Plan Graph inactive-wrapper guard changed the configured RC.71 server source again. The v0.2/v3/v0.5.1 successors above remain historical and untouched. Current source inventory successors:

- RecordEvent inventory v3: `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T054500Z-v3.json`, SHA-256 `436e1444ccbe079c7d8d9027126fbb524aa03f5fc07c6ce24604d6ce62e30c5e`; 88 files, 116 callsites. All 116 semantic callsite tuples match prior v2; no event producer added or removed.
- RecordEvent register v0.3: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.3.json`, SHA-256 `94f90d77d4e1b1c506cb43727ac730ba6d56a6e110666b315611cb9befa7f601`; source hashes and current callsite line numbers refreshed.
- Direct SQL inventory v4: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261031T054500Z-v4.json`, SHA-256 `b944d4e74568a1f3c0de89bb128a3652fb062f5a654bb079de01bea26040b3d5`; 159 files, 1,460 callsites, 242 data writes; operation-class counts unchanged.
- Event query register v0.5.2: `docs/agg-external-checkpoint-v2-event-query-register-20261030-v0.5.2.json`, SHA-256 `48dd6ec6fa04c4f4b6b86e78a4f5b755a56b057b82ad618b483830262d660156`; source inventory path and digest exactly match v4; 193 event SQL callsites (189 readers, three writers, one schema-only bootstrap).

Focused tests now select v0.3/v4/v0.5.2: `node --test tests/test-agg-v2-event-callers.mjs tests/test-agg-v2-sql-mutation-audit.mjs` — exit 0, 20/20. The server source hash is `12a8b3349bea1d6ae2347acb9b324d59c3686306961ce14a92c5f732038af57a`. These remain lexical source inventories only; authorization semantics and frozen 71-path projection are unresolved.

#### Execution Plan Candidate verifier source-drift successor — 2026-10-31

The local Execution Plan Candidate verifier now recomputes the embedded compiler plan hash and validates the compiler plan, reviewed task-input contract, compiler action-intent bindings, evidence projection, role/artifact contract digests, dependency projection, candidate fingerprint and review-only gates. The regression test proves that changing plan arguments, evidence hashes or reviewed intent and merely recomputing the outer candidate hash is rejected. The source-only RecordEvent inventory therefore received a new successor rather than rewriting v0.3:

- Inventory v4: `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T063000Z-v4.json`, SHA-256 `de66d8c7784a6290c8287cd4268e18a97c286159ea367723ccde24567b775311`; 88 files, 116 callsites.
- Register v0.4: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.4.json`, SHA-256 `740b40d60ea93c7da98564a1640ce3840ae9a9774705abe3b58b04c11a65987a`; all source hashes refreshed, no RecordEvent producer callsite or event tuple added/removed.

This remains a source-callsite drift baseline, not an event authorization registry or accepted V2 projection manifest. V2-01 remains OPEN.

#### Plan approval transaction and reviewer readback source-drift successor — 2026-10-31

The RC.71 v144 slice changed the configured entrypoint, `src/runtime/job-store.js` and `src/runtime/adaptive-goal-reviewer-identity.js`. No `recordEvent()` producer tuple was added or removed. The updated RecordEvent inventory/register and direct-SQL/query register are:

- RecordEvent inventory v5: `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T065755Z-v5.json`, 88 files/116 callsites. All semantic callsite tuples match v4; only source hashes and line locations changed.
- RecordEvent register v0.5.5: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.5.5.json`, SHA-256 `c582ecd67a6172d576d30a8b85f40a90909e76a46984143ec1e7793c6cde7fda`. It retains all 116 callsites and 17 computed-expression resolutions; the two direct SQL event writers have exact current writer/readback lines. Intermediate v0.5 through v0.5.4 drafts remain preserved but are not selected by tests or treated as current.
- Direct SQL inventory v5: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261031T065755Z-v5.json`, 159 files/1,464 callsites/242 data writes. Four additional transaction-control callsites are attributable to the new standalone `BEGIN IMMEDIATE`/commit/rollback envelope around immutable plan persistence; data-writer count is unchanged.
- Event query register v0.5.3: `docs/agg-external-checkpoint-v2-event-query-register-20261031-v0.5.3.json`; source inventory path and digest pin v5; 193 event SQL callsites (189 readers, three writers, one schema-only bootstrap). This register remains query-shape evidence only.

Focused source-drift tests: `node --test tests/test-agg-v2-event-callers.mjs` — exit 0, 8/8; `node --test tests/test-agg-v2-sql-mutation-audit.mjs` — exit 0 (captured log `/tmp/runalith-agg-v2-sql-audit-final.log`). The RecordEvent test cross-checks all 116 tuples and the direct-SQL register; the SQL audit test checks current source inventory and all 193 event queries. These remain source-only inventories, not the frozen Phase 2 path manifest, an event allowlist, V2 projection manifest or deployment evidence.

### Disposable source-module DB startup/restart contract

```sh
node scripts/capture-agg-v2-disposable-db-contract.mjs
```

The harness creates a private temporary directory under the operating system temp root, redirects `WORKFLOW_DATA_DIR`/`WORKFLOW_DB` there before importing the source `WorkflowStore`, initializes the trust ledger through its active source initializer, captures connection-local PRAGMAs and the logical `sqlite_master` schema digest, closes both connections, reopens the same disposable files, repeats initialization and compares the schemas. Temporary files are removed in a `finally` path. It accepts no database path supplied by the caller and does not use the configured user data directory.

The captured evidence is:

`artifacts/adaptive-goal-graph/rc71-disposable-db-contract-restart-20261030T072225Z.json`

SHA-256: `582fc241e36706045072ac67e06a0cddbe7419bf29c20fee21f23c36f0c6dd25`.

The workflow connection returned `foreign_keys=1`, `synchronous=2 (FULL)`, `busy_timeout=5000`, `locking_mode=normal`, and `journal_mode=wal`; its 26-table/64-object schema digest was `4283cb8bcab31650722ae2bc5e9b37e7728f0265e2c317907d22b77bc9de0433`. The trust connection returned `foreign_keys=1`, `synchronous=2 (FULL)`, `busy_timeout=0`, `locking_mode=normal`, and `journal_mode=delete`; its 2-table/7-object schema digest was `1640d455a6a10627804c8a59b1bef93614700935f8e4a32568b90d29d0dbc849`. Each schema digest and those PRAGMAs were unchanged after the second initialization.

This harness is not an existing-production-database migration test. It starts with a new empty temporary database, then applies the current source initializers again. It does not establish compatibility with historical schemas, partial/failed migrations, crash/power-loss recovery, cross-database atomicity or coherent snapshots, deployed-host settings, external authority or custody. Its 26/64 WorkflowStore-only schema boundary also differs from the full active-server startup snapshot in inventory §11.1 (45/126, including host-owned tables).

### Historical RC.23 to current RC.71 database compatibility

```sh
node --test tests/test-agg-rc23-to-rc71-migration.mjs
```

This regression extracts the immutable historical RC.23 MCPB into a private temporary directory, verifies its exact archive SHA-256 (`00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e`), and initializes the database with the archived RC.23 `src/runtime/job-store.js`. It seeds one job and one append-only event, closes the old connection, opens the same disposable database with current RC.71 source, then closes/reopens RC.71 a second time. It verifies row/event preservation, no event duplication, stable schema digest across RC.71 restart, `foreign_keys=1`, `synchronous=FULL`, and `journal_mode=wal`. No production path is accepted; the test controls all database paths through a fresh private temp directory.

This is an actual historical-source compatibility probe, not a fabricated legacy schema. It covers one RC.23-to-RC.71 path only. It does not prove every intermediate release migration, interrupted DDL transaction recovery, power-loss durability, the separate trust-ledger migration/cutover, or host-managed deployment migration. It does not authorize V2-05 or close #36.

## 2. How to turn the output into implementation work

Use the following sequence rather than jumping directly to V2-08 implementation:

1. Review the checked-in computed-producer notes and the two direct SQL writer/query bindings. Keep the unbounded public event parameter, all 72 literal event types pending query classification, optional-module deployment reachability, aliases/wrappers and non-SQL writers explicitly open; continue query-by-query tracing for every event type and authorization reader.
2. Build the versioned event registry required by the normative design: event type/schema version, security projection classification, strict payload schema, producer and consumer references, row ordering/tie-breakers, null/absence rules and compatibility treatment. Add a regression that compares source callsites and all direct event writers with that registry. Do not change the generic writer enforcement seam until the implementation decision and migration compatibility design are approved.
3. Build historical schema fixtures from known pre-migration schemas (only when their exact source/DDL is available). For each migration family, capture before/after `sqlite_master`, `table_info`, foreign keys, indexes, triggers and required PRAGMAs. Add interruption/failure injection at each migration boundary and prove retry/recovery behavior in disposable copies. Do not manufacture a legacy schema from the current fresh schema and label it historical.
4. Define query-by-query V2-08 projection logic from complete readers/writers and mutation paths. Tests should mutate each included authorization input and prove the relevant digest changes; malformed, unknown or missing required inputs must fail closed. Do not substitute file/WAL hashes or SQLite `ATTACH` for a coherent logical snapshot.
5. Obtain separate operational evidence for the actual deployed entrypoint, all processes/workers opening either DB, host-managed schema/migration behavior, production trust and independently administered external checkpoint/attestation. Source scans and disposable tests cannot produce those facts.

## 3. Safety and evidence classification

| Activity | What it proves | What it does not prove |
|---|---|---|
| Static event scan | Scanner-visible `recordEvent()` callsites plus two separately cross-checked direct SQL `INSERT INTO events` writers and three exact reader query/binding sites | Deployed imports, additional processes, all direct SQL/non-SQL writers, all readers, complete event semantics or external authority |
| Disposable DB harness | Current source constructors/initializer settings on fresh local connections and repeat-initialization schema stability | Historical upgrade safety, failure recovery, production DB settings, durability under power loss or cross-file atomicity |
| RC.23-to-RC.71 migration regression | One exact historical package source initializes a DB that current RC.71 opens and restarts without losing seeded job/event rows or changing schema on the second startup | All intermediate migrations, interruption/crash recovery, separate trust-ledger consolidation, deployment behavior, independent identity/custody or production acceptance |
| Local preflight PASS | Those bounded scripts, docs check and whitespace check passed on this checkout | V2-01/V2-08 acceptance, any GitHub issue closure, package reproducibility, release eligibility or rollout readiness |

The output files are local working evidence, not signed release provenance or independent measurement. Do not upload, pin, approve, activate or promote a candidate based only on these files. Do not run the scripts with production database paths or edit them to accept arbitrary database paths.

**Current gates remain:** V2-01/#32 OPEN; the V2 projection is not ready to freeze; #33 identity, #34 external checkpoint authority and #35 attestation/verifier evidence remain external blockers; rollout remains `BLOCKED`. Follow the dependency graph in the decision register and preserve `Untriaged` priority unless the Project Owner changes it.

## Reviewer ingestion error-code and cross-process replay recovery successor — 2026-10-31

`ingestAdaptiveGoalReviewerAttestation()` passed error-code arguments to the shared `fail(message, code)` helper in reverse order. The rejection message contained the symbolic code, so message-regex tests passed, but `error.code` was set to descriptive text. Callers could not reliably classify replay, stale-candidate, malformed-input, lifecycle, readback or persistence failures. All ingestion callsites now pass `(message, stableCode)`; signature/readback semantics are unchanged.

Added a disposable disk-backed regression that holds a parent `BEGIN IMMEDIATE` fence while two independent Node processes open the same workflow/trust DB files and signal immediately before their own writer reservation. The parent releases only after both pre-BEGIN markers. With distinct job IDs and the same signed nonce, exactly one process persists; the other receives `AGG_REVIEWER_ATTESTATION_INGEST_REPLAY` through `error.code`. After closing and reopening both DB files, the winning attestation verifies byte-for-byte, exact retry returns idempotent success, and the losing nonce remains rejected. Because `DatabaseSync.exec()` blocks synchronously, the marker cannot independently prove both OS processes are already blocked inside SQLite at the same instant. No production trust or DB is used.

Source inventory successors (historical artifacts remain unchanged):

- RecordEvent inventory v6: `artifacts/adaptive-goal-graph/rc71-record-event-callers-20261031T073101Z-v6.json`, SHA-256 `c2f43b517b970b34f6494f3b397080e65ac023f1079f3bea6275e1300ef48adb`; 88 files/116 callsites. Only reviewer source pin changed; it contains zero `recordEvent()` callsites. Semantic producer tuples unchanged.
- RecordEvent register v0.5.6: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.5.6.json`, SHA-256 `93e13e0a645c95a5df33c9e9f12c0e23517457ed1083df0c7ab5c6ffa983d917`; predecessor v0.5.5 retained.
- Direct SQL inventory v6: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261031T073101Z-v6.json`, SHA-256 `5fa79c2c3a168ad3b6f85d9a1be05263a47524d01dc1d526e98aedcd11500d24`; 159 files/1,464 callsites/242 data writes, operation classes unchanged.
- Event query register v0.5.4: `docs/agg-external-checkpoint-v2-event-query-register-20261031-v0.5.4.json`, SHA-256 `c758e508e342a7b52ae2e8dd5aaf250692b53bd21b0d1eeb4eb8a354ebb7048b`; 193 callsites (189 readers, three writers, one schema-only bootstrap).

`node --test tests/test-adaptive-goal-reviewer-identity.js` — PASS 16/16. The initial RED run first exposed a test harness `REPO_ROOT` reference error; after correcting it to the process working directory, the concurrency assertion exposed the reversed `fail()` arguments. RecordEvent + SQL inventory tests — PASS 20/20 against v0.5.6/v0.5.4. These remain source-only inventories, not a normative projection manifest, deployed process inventory or external authority.

## RC.72 local package successor — 2026-10-31

The source tree now identifies package `1.0.9-rc.72` and versioned entrypoint `server/index-v1.0.9-rc.72-versioned-approval-subsystem-20261031.js`. The new local archive is `dist/runalith-1.0.9-rc.72-engineering-successor-20261031.mcpb`, SHA-256 `88aa3bc990834c897bb6216c7f8e1b2ae0d6b6b308bffeb8730a0d5d5ee14c6b` (1,007,696 bytes). `unzip -t` and exact source alignment pass: 109 entries, 75 tools, source snapshot `f85ee2f4b755919134e073dc2f47aad547fc42be71bcf569c7a26e3f40625370`. Extracted MCP initialize/tools-list 75/75, schema checks 75/75, and extracted three-graph E2E pass. Build log `/tmp/runalith-rc72-package-build-20261031.log`, SHA-256 `0a7b4b298d54dc61a5520e3a5440e4f20a2cf36726a8fa4ff4af67bd898e6875`.

Source alignment is exact against the current dirty-tree bytes, not an authenticated controlled-builder receipt. The package script explicitly reports release eligibility BLOCKED pending authenticated build receipt and independent authority. RC.23 and RC.71 archives remain untouched; RC.71 source alignment remains FAIL. RC.72 is not installed, activated, independently verified or production-ready. The Phase 2 owner-signed 71-path contract, all six RC.23 gates and D-01 remain open.

### RC.72 final source-aligned build v2

The preserved v2 local package snapshot is `dist/runalith-1.0.9-rc.72-engineering-successor-v2-20261031.mcpb`, SHA-256 `a1f2a7cce41e21ef66f37f21c0856a5b656838e41287f92b3b436d9b1bb078f1`, 1,007,947 bytes. Source snapshot SHA-256 `d138f2c08f2b41ba86f2bfbe7fa8392d1fb6d11811caeecee2b378adab0cb910`; 109 archive entries/75 tools. ZIP integrity and source alignment PASS. Build log `/tmp/runalith-rc72-package-build-v2-20261031.log`, SHA-256 `d1ad43ae5fec7746d036d8f7008602d0914ae9aafac5a052d85122155f4d2f0a`.

The first RC.72 build remains preserved as an earlier source-aligned snapshot; v2 carries the parent-held writer-fence reviewer regression. Neither build has an authenticated controlled-builder receipt or independent verifier/release approval. Release eligibility remains BLOCKED; neither is installed or activated.


### RC.72 current build v3

Current local package: dist/runalith-1.0.9-rc.72-engineering-successor-v3-20261031.mcpb, SHA-256 b3b30c37f90cfbc9159e097619e6df4b5f6c2c9aba30ca20e1e1d564e274f0b6, 1,007,949 bytes. Source snapshot SHA-256 6159d92897ee2694c4fc3d86998097b1ec2c2bc94ad350979c00887c29c95255; 109 entries/75 tools. ZIP integrity and source alignment PASS. Build log /tmp/runalith-rc72-package-build-v3-20261031.log, SHA-256 b4217f1da8004ca8155ce49d7f9be9692a9d89d2ad0babe7f9f46b809aa1874b.

Package version is 1.0.9-rc.72. The package main/runtimeEntryPoint and manifest entrypoint reuse the unchanged RC.71 versioned server entrypoint; the runtime fix is in src/runtime. This avoids duplicate source callsites. The temporary duplicate RC.72 entrypoint was removed.

RecordEvent/direct-SQL inventory v7 and event-query register v0.5.5 remain preserved but unselected drafts. Duplicate RC.72 entrypoint callsites made the RecordEvent semantic tuple comparison fail; no v0.5.7 RecordEvent register was selected. Current tested selections remain RecordEvent inventory v6/register v0.5.6 and direct-SQL inventory v6/event-query register v0.5.4.

v3 is source-aligned only to current dirty-tree bytes. It has no authenticated builder receipt or independent release approval; release eligibility remains BLOCKED. No installation or activation.


Full repository regression after RC.72 package identity and v164 benchmark: npm test exit 0, 29 Node test runs / 421 assertions, zero failures. Log /tmp/runalith-agg-three-graph-full-test-rc72-v164-final.log, SHA-256 6742a9bdfaeb6633d36c252a776a0c05a0b450f519c9e6a44e5a295ab5f8c052. Documentation validation: 209 Markdown files, 506 local links, 75 MCP references; git diff --check PASS. These are local validation results only.

## D-01 separate-file failure and retry probe — 2026-10-31

Run the focused verifier suite:

```sh
node --test tests/test-adaptive-goal-knowledge-verifier.mjs
```

The D-01 test creates two private on-disk SQLite files, injects a workflow verification-row failure after the trust observation commits, reopens both DBs, holds a second trust connection's `BEGIN IMMEDIATE` writer lock to prove the verifier fails closed before a workflow attestation write, then releases the lock and verifies exact retry/recovery without duplicating the trust observation. It intentionally demonstrates that trust history and workflow verification can commit separately. It is not a cross-database atomicity proof and must not be used to justify a production migration or activation.

The same test is included in `dist/runalith-1.0.9-rc.72-engineering-successor-v4-20261031.mcpb`; extracted-package run passed 15/15. Full local `npm test` passed 29 Node test runs / 422 assertions. These are local regressions only. D-01 remains OPEN pending canonical database identity/generation, owner-approved consolidation and legacy archive plan, complete writer inventory/process fencing, lock-order and WAL/checkpoint barrier contract, crash/partial-commit/restore proof, independent external anchor continuity and explicit authorization.

Extracted-package integration probe for the local RC.72 v4 archive:

```sh
EXTRACT=/tmp/runalith-rc72-v4-extract
(cd "$EXTRACT" && node --test tests/test-adaptive-goal-current-scope-producer-e2e.mjs)
```

PASS 1/1: nine typed producer artifacts → nine-node Plan Graph DAG → durable Execution Graph proposal; immutable plan pin, isolated snapshot/reviewer attestations and fail-closed negatives. `dispatched=true` is only a private isolated test DB transition under disposable test trust, never production dispatch evidence.

## 2026-11-01 ownership-boundary inventory successors

The source inventories were reconciled after Agent Session, CASE-01 snapshot, Workspace Write and AGG candidate interpretation moved behind named owner APIs. Historical baselines remain byte-immutable.

- RecordEvent caller inventory `docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.10.json`, SHA-256 `1635a4a7bf5a3e0799d7873a4d394f40b041f458bdf2991419c2da3df57af65d`; 104 files, 114 callsites (97 literal, 17 computed), 71 literal event types.
- RecordEvent caller register `docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.10.json`, SHA-256 `b73666fdf86a44d528d27a00e707b20445c091dbb5b636345d0ee9555d0b248c`; predecessor v0.5.9 SHA-256 `b5707b2ba88a7f84ab85593e3ea59df62f6e0ede7d426f5b84c8cb5697d7ed7d` is pinned by regression test. Ownership crosswalk: 15 callsites moved from WorkflowStore to AgentSessionStore, two from the RC.71 entrypoint to Case01SnapshotService, and one from the entrypoint to WorkspaceWriteCapabilityService. Event producer counts/types remain unchanged. Three computed Agent Session branches retain reviewed predecessor semantics with new source locations.
- SQL inventory v10 `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T021528Z-v10.json`, SHA-256 `509b78e6fab8852e95d0d838716eb0acc6bd6853b1b41ec09a861181271dda41`.
- Event query register v0.5.9 `docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.9.json`, SHA-256 `7ef80486b1c75fc3cd9874b67a4101ca1a7e8aa78e624e4a97d78409997ce5e8`; predecessor v0.5.8 SHA-256 `d2190e6eb5d6ffd721c77534a0d6e8dbb22556cf22d3a8994cf22031f17d3bfe` is preserved but superseded because its scanner omitted static SQL references inside interpolated template literals. The corrected scanner retains static segments, records referenced tables and static-shape hashes, but keeps seven dynamic SQL queries classified `unresolved`. Current register: 134 event-related SQL callsites across six files (123 readers, one schema bootstrap, seven unresolved, three writers); 15 parameterized event-type selectors and 38 literal query selectors. The new `workflow-state-predicates.js:58` entry records the nested `EXISTS (SELECT 1 FROM events ...)` predicate for `task.lease.quarantined` without promoting its dynamic SQL to a fully classified reader.
- Historical v0.5.7 event-query register SHA-256 `95af5a64cdb86d82b850f030c135b3815bbf3d0e1d60daae88c8cfb7d8a63dd8` and v8 inventory SHA-256 `2b9b792f6b96bfe3de1c5507d891908a123a59b99624e6c6166feec90b5072db` remain pinned. The v0.5.8 intermediate register and v9 inventory are also hash-pinned as immutable superseded evidence.

These registers remain source-discovery evidence only. They do not define an event allowlist, projection schema, authorization policy, deployed process inventory or external authority. Dynamic SQL remains unresolved; nested references now visible in the scanner still require semantic, caller and transaction review.
