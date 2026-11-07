# AGG V2 source inventory successors — 2026-11-01

This note records reviewed source-only inventory successors. It does not create event authorization, a normative projection manifest, production deployment evidence, or release authority.

## RecordEvent caller inventory v0.5.11

- Inventory: `docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.11.json`
- SHA-256: `759603c89e965b6d184ea781cb50ab4f613097d120ea8c89a8f08afc61f2c2f7`
- Register: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.11.json`
- SHA-256: `e3e9339da85d81110d54788445d8a5380e3bee80bb3c5f14eba255f7e72d52d6`
- Predecessor register v0.5.10 SHA-256: `b73666fdf86a44d528d27a00e707b20445c091dbb5b636345d0ee9555d0b248c` (immutable; separately hash-pinned by regression test).
- Coverage: 105 files, 114 callsites (97 literal, 17 computed), 71 distinct literal event types.

Nine runtime source files changed and `src/runtime/execution-persistence-participant.js` was added with zero `RecordEvent` callsites. All 114 callsites preserve their file, job-id argument, event-type expression, classification and literal value. Twelve computed-producer resolution keys shifted line number; successor register rebinds them by stable callsite tuple and retains exact prior resolution objects. No callsite was added or removed. Earlier owner moves remain: 15 callsites to AgentSessionStore, two to Case01SnapshotService and one to WorkspaceWriteCapabilityService.

## RecordEvent caller inventory v0.5.12

- Inventory: `docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.12.json`
- SHA-256: `5e61bafae09d360bf550db5f98c03cb9836e9e73014370c015c25e8a5787ce3f`
- Register: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.12.json`
- SHA-256: `05f1b599f8c47d4ad9cd9626e860a74a6c2d853042a7dfc209e475387edf7eaf`
- Immediate predecessor v0.5.11 inventory SHA-256: `759603c89e965b6d184ea781cb50ab4f613097d120ea8c89a8f08afc61f2c2f7` (immutable).
- Immediate predecessor v0.5.11 register SHA-256: `e3e9339da85d81110d54788445d8a5380e3bee80bb3c5f14eba255f7e72d52d6` (immutable).
- Coverage: 106 files, 114 callsites (97 literal, 17 computed), 71 distinct literal event types.

Five runtime files changed after v0.5.11: `langgraph-control-loop.js` and `langgraph-orchestrator.js` now use WorkflowStatePort/WorkflowControlPort; `workflow-control-port.js` is a new immutable lifecycle port with zero event callsites; `agent-session-store.js` and `workflow-state-port.js` enforce exact shared SQLite connection identity for Agent Session row/event atomicity. No source files were removed. All 114 callsite tuples preserve file, job-id argument, event-type expression, classification and literal value. Three computed-producer resolution keys shifted line number; the successor rebinds them by stable callsite tuple and retains exact prior resolution objects. No callsite was added or removed. Historical v0.5.10 and v0.5.11 inventory/register bytes remain hash-pinned by regression tests.

## RecordEvent caller inventory v0.5.13

- Inventory: `docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.13.json`
- SHA-256: `242ee3a5564ba62e84f33e89c20fa8bcc6a4239130de05fc7339777f0c7762e2`
- Register: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.13.json`
- SHA-256: `3f1ee97bf5073a2b4ecb899e3131886209dd3433748a670e6dafd7d042241aaf`
- Immediate predecessor v0.5.12 inventory SHA-256: `5e61bafae09d360bf550db5f98c03cb9836e9e73014370c015c25e8a5787ce3f` (immutable).
- Immediate predecessor v0.5.12 register SHA-256: `05f1b599f8c47d4ad9cd9626e860a74a6c2d853042a7dfc209e475387edf7eaf` (immutable).
- Coverage: 107 files, 114 callsites (97 literal, 17 computed), 71 distinct literal event types.

Eight runtime files changed after v0.5.12: seven AGG consumers now import canonical JSON/plan validation through Workflow Plan API v1 and role/action-intent contracts through the root Agent Contracts API; `workflow-plan-public-api.js` is the new frozen, two-method host facade with zero event callsites. CodeGraph confirms no AGG runtime module imports private `workflow/plan.js` or `workflow/agent-contracts.js`; only the facade, Workflow/Execution core and host scripts retain those internal imports. No source files were removed. All 114 callsite tuples and all 17 computed-producer resolution objects are unchanged; no line-key rebinding was required. Historical v0.5.10, v0.5.11 and v0.5.12 bytes are hash-pinned by regression tests.

## RecordEvent caller inventory v0.5.14

- Inventory: `docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.14.json`
- SHA-256: `e6c141df0bc3c37518f96b581b04a7780ee1bf5ee0743145b1f42846873265ff`
- Register: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.14.json`
- SHA-256: `8fc3428891b4dc4323f22100799376159344f0772e2c5c70c193ab89ba9d604d`
- Immediate predecessor v0.5.13 inventory SHA-256: `242ee3a5564ba62e84f33e89c20fa8bcc6a4239130de05fc7339777f0c7762e2` (immutable).
- Immediate predecessor v0.5.13 register SHA-256: `3f1ee97bf5073a2b4ecb899e3131886209dd3433748a670e6dafd7d042241aaf` (immutable).
- Coverage: 107 files, 114 callsites (97 literal, 17 computed), 71 distinct literal event types.

WorkflowStatePort v2 absorbed the final `execution.spawn_authorized` writer into `authorizeExecutionSpawn`; that single literal callsite moved from `execution-manager.js` to `workflow-state-port.js`. Event type and classification are unchanged; the job-id argument is now the validated Workflow-owned `jobId`. No event type was added or removed and all other 113 callsite tuples are unchanged. No computed-producer line keys shifted; all 17 exact prior resolution objects are preserved. The old caller-managed begin/commit/rollback methods are gone. The new command performs plan/approval/batch/lease/start-event revalidation, append/readback and COMMIT/ROLLBACK in one Workflow-owned writer transaction. Historical v0.5.10–v0.5.13 artifacts remain hash-pinned.

## RecordEvent caller inventory v0.5.15

- Inventory: `docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.15.json`
- SHA-256: `3391a2cb3611dd72081ae15588830cd5e2448aea09104ad47d69e9db56e8ce32`
- Register: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.15.json`
- SHA-256: `5032b44381093325486488c6a9ab65bd27c53c43e06fc4230ed1509509f0502a`
- Immediate predecessor v0.5.14 inventory SHA-256: `e6c141df0bc3c37518f96b581b04a7780ee1bf5ee0743145b1f42846873265ff` (immutable).
- Immediate predecessor v0.5.14 register SHA-256: `8fc3428891b4dc4323f22100799376159344f0772e2c5c70c193ab89ba9d604d` (immutable).
- Coverage remains 107 source files, 114 callsites (97 literal, 17 computed), 71 distinct literal event types.

`ProviderAdmissionController` now requires `WorkflowStatePort` v2 instead of accepting an unversioned task/event-shaped adapter. This is a source-only contract validation change; the file's single `recordEvent` callsite and all 114 semantic callsite tuples remain unchanged. Inventory comparison found exactly one changed source SHA-256 (`src/runtime/provider-admission.js`), no added/removed source files and no callsite additions/removals. Its one computed-producer resolution key moved from line 269 to 270 and retains the exact predecessor resolution object. This successor records the implementation change; it is not an event authorization registry or external authority evidence. v0.5.14 bytes remain pinned by regression assertions.

## Direct SQL / event query inventory successors

- Inventory v11: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T024303Z-v11.json`
- SHA-256: `ee7be7c9d3ca8b5d5d7a9fe3664891f6966e672ac35a7fbfe4a2b54e912f0672`
- Event query register v0.5.10: `docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.10.json`
- SHA-256: `29a7c085116277c9c4393bbc6825003a9021004f9cfef43b0a6e640331227324`
- Predecessor register v0.5.9 SHA-256: `41149223f9a198ba9e345899d82db7b855cc18f451f63a99ec32489261860679` (immutable).
- Predecessor SQL inventory v10 SHA-256: `509b78e6fab8852e95d0d838716eb0acc6bd6853b1b41ec09a861181271dda41` (immutable).

WorkflowStore core now reads provider ledgers through `ExecutionPersistenceParticipant` v1; DDL/SQL remains in WorkflowStatePort. The query register still records 134 event-related SQL callsites across six files: 123 readers, one schema bootstrap, seven unresolved and three writers; 15 parameterized selectors and 38 literal selectors. Seven dynamic SQL queries remain unresolved. `workflow-state-predicates.js:58` retains the nested `EXISTS (SELECT 1 FROM events ...)` reference for `task.lease.quarantined` without promoting dynamic SQL to a fully classified reader.

### Inventory v12 and event query register v0.5.11

- Inventory: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T044931Z-v12.json`
- SHA-256: `bd8a12823b4c684763d6186b3a3076b66fa44763917bcc9975eedbdfc0cfdfae`
- Register: `docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.11.json`
- SHA-256: `14b72eb0ec5fe7ca34fef52a9f3f161dc27c7048f9ea96dde283216b449e1728`
- Immediate predecessor v11 inventory SHA-256: `ee7be7c9d3ca8b5d5d7a9fe3664891f6966e672ac35a7fbfe4a2b54e912f0672` (immutable).
- Immediate predecessor v0.5.10 register SHA-256: `29a7c085116277c9c4393bbc6825003a9021004f9cfef43b0a6e640331227324` (immutable).
- Coverage: 178 source files, 1,309 direct SQL callsites; event query register remains 134 entries across six files (123 readers, one schema bootstrap, seven unresolved, three writers).

Three event-query-bearing files changed after v0.5.10: approval/reviewer modules now import canonical JSON via Workflow Plan API v1; WorkflowStatePort gained a non-SQL SQLite connection identity guard, shifting later method line references. All 1,309 SQL callsite tuples and operation classes remain stable. All 134 event-query entries preserve SQL expression/hash, API, operation, object references, event selectors, query purpose, transaction classification and caller identity; 59 line references are rebound because WorkflowStatePort gained the guard before existing methods. No query was added, removed, reclassified or promoted from unresolved. v11 inventory and v0.5.10 register remain hash-pinned by regression tests.

### Inventory v13 and event query register v0.5.12

- Inventory: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T051851Z-v13.json`
- SHA-256: `7eb0a5495c4af52c3df4e01774147da05bfb039071f2754fe7883aa15bb6ff5e`
- Register: `docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.12.json`
- SHA-256: `0d3fd07f457d0d86eb24956bd8b68e1a768445cb55de0ce4738b5be58b206112`
- Immediate predecessor v12 inventory SHA-256: `bd8a12823b4c684763d6186b3a3076b66fa44763917bcc9975eedbdfc0cfdfae` (immutable).
- Immediate predecessor v0.5.11 register SHA-256: `14b72eb0ec5fe7ca34fef52a9f3f161dc27c7048f9ea96dde283216b449e1728` (immutable).
- Coverage: 178 source files, 1,309 direct SQL callsites; event query register remains 134 entries across six files (123 readers, one schema bootstrap, seven unresolved, three writers).

WorkflowStatePort v2 now contains the single atomic spawn authorization command; ExecutionManager no longer controls BEGIN/COMMIT/ROLLBACK. The SQL inventory retains all 1,309 callsite identities and operation classes. All 134 event-query expressions, SQL hashes, APIs, operations, object references, event selectors, query purposes, transaction classifications and caller identities remain unchanged; 59 line references are rebound to the current source. No SQL query was added, removed, reclassified or promoted from unresolved. v12 inventory and v0.5.11 register remain hash-pinned.

### RecordEvent caller inventory v0.5.16

- Inventory: `docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.16.json`
- SHA-256: `bf59b53028cd4b605b5b47b17434fdd9f9d980fb0a110f37556c19efe283e78e`
- Register: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.16.json`
- SHA-256: `b0d98e129dfc7a3e81b8e6a1b51f7e21ac29bf93b30b402952f3546923bb966a`
- Immediate predecessor v0.5.15 inventory SHA-256: `3391a2cb3611dd72081ae15588830cd5e2448aea09104ad47d69e9db56e8ce32` (immutable).
- Immediate predecessor v0.5.15 register SHA-256: `5032b44381093325486488c6a9ab65bd27c53c43e06fc4230ed1509509f0502a` (immutable).
- Coverage: 108 source files, 114 callsites (97 literal, 17 computed), 71 distinct literal event types.

`ExecutionPersistenceStore` v1 now owns provider-run and dispatch-intent DDL/read models. `WorkflowStatePort` delegates provider-ledger reads while retaining provider write/CAS coordination and cross-domain transaction fences on the exact shared SQLite connection. The new store is one additional source file with zero `RecordEvent` callsites. All 114 semantic callsite tuples and all 17 computed-producer resolution objects remain unchanged. Existing line positions are rebound to the exact current inventory. This is source ownership evidence only; it does not transfer physical database ownership or create event authorization.

### Direct SQL inventory v14 and event query register v0.5.13

- Inventory: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T070000Z-v14.json`
- SHA-256: `f755504894ac0ed025949601b25481219b406eaeaa5bfb49a37eb5caa905a768`
- Register: `docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.13.json`
- SHA-256: `6a5cd662a6cfde9177976ed0439cf7be8ffc4f4c6531cdff2491bab1a6b582da`
- Immediate predecessor v13 inventory SHA-256: `7eb0a5495c4af52c3df4e01774147da05bfb039071f2754fe7883aa15bb6ff5e` (immutable).
- Immediate predecessor v0.5.12 register SHA-256: `0d3fd07f457d0d86eb24956bd8b68e1a768445cb55de0ce4738b5be58b206112` (immutable).
- Coverage: 179 source files, 1,309 direct SQL callsites; operation counts unchanged. Event query register remains 134 entries across six files (123 readers, one schema bootstrap, seven unresolved, three writers).

17 provider-ledger SQL callsites moved from `WorkflowStatePort` to `ExecutionPersistenceStore` with unchanged SQL expressions and operation/object classifications. The 134 event-query entries remain semantically identical; nine source line/caller-context bindings were refreshed after `WorkflowStatePort` source contraction. No event query was added, removed, reclassified or promoted from unresolved. Neither inventory grants schema authority or proves independent physical database ownership.

### RecordEvent caller inventory v0.5.17

- Inventory: `docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.17.json`
- SHA-256: `324079147e592e72abcf0576cf8ab3d8dc4ce2ea434d89939451714cd9de6108`
- Register: `docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.17.json`
- SHA-256: `a800b4489e5f8431b9b9eeaf69a7f3c8e21219bab5b7caf9eb52b43545436201`
- Immediate predecessor v0.5.16 inventory SHA-256: `bf59b53028cd4b605b5b47b17434fdd9f9d980fb0a110f37556c19efe283e78e` (immutable).
- Immediate predecessor v0.5.16 register SHA-256: `b0d98e129dfc7a3e81b8e6a1b51f7e21ac29bf93b30b402952f3546923bb966a` (immutable).
- Coverage: 108 source files, 114 callsites (97 literal, 17 computed), 71 distinct literal event types.

The provider-ledger-only SQL bodies for reservation, outcome persistence, run persistence/binding, reconciled binding and no-send claim release now reside in `ExecutionPersistenceStore`. WorkflowStatePort keeps compatibility wrappers and cross-domain send/result/lease fences. Exact source hashes for the two changed files were refreshed; all 114 semantic RecordEvent tuples, all 17 computed-producer resolution objects, and both direct SQL event-writer records remain unchanged. No line rebindings were required. This does not transfer Workflow-owned attempts/results/leases/batches/events or independent DB transactions.

### Direct SQL inventory v15 and event query register v0.5.14

- Inventory: `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T074005Z-v15.json`
- SHA-256: `d1e6f1ff59046a77bff93b611837245617f3f4f90cba413bb05cd4f5d5cb3cb3`
- Register: `docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.14.json`
- SHA-256: `494155e5b12c5efa4f3ccbca15ba095c833d10626877bb7e480208999b4183df`
- Immediate predecessor v14 inventory SHA-256: `f755504894ac0ed025949601b25481219b406eaeaa5bfb49a37eb5caa905a768` (immutable).
- Immediate predecessor v0.5.13 register SHA-256: `6a5cd662a6cfde9177976ed0439cf7be8ffc4f4c6531cdff2491bab1a6b582da` (immutable).
- Coverage: 181 source files, 1,309 direct SQL callsites, 245 data writes; an additional 25 provider-only SQL callsites moved from WorkflowStatePort to ExecutionPersistenceStore without changing SQL semantics. Cumulative provider-ledger SQL ownership is now 42 callsites (17 in v0.5.16 plus 25 in this successor). Event query register remains 134 entries across six files (123 readers, one schema bootstrap, seven unresolved, three writers).

All 134 event-query shapes and caller identities remain unchanged; nine source line bindings in WorkflowStatePort were rebound after method extraction. The seven unresolved queries remain unresolved. The inventories are lexical source evidence only, not complete writer proof, a V2-08 manifest or physical DB ownership proof.

## Evidence limitations

These are lexical source inventories, not complete AST/call-graph proofs, event allowlists, authorization registries, deployment attestations, projection manifests, or proof of deployed process reachability. Historical inventory/register bytes are immutable; successors are append-only and reviewed against predecessor callsite semantics. No production database, schema, process, or external authority state was changed.
