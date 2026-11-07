import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanSqlAuditFile, scanSqlMutationCallsites } from '../scripts/audit-agg-v2-sql-mutation-callers.mjs';
import { buildEventQueryRegister } from '../scripts/build-agg-v2-event-query-register.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('direct SQL audit classifies literal data/schema writes and reads', () => {
  const rows = scanSqlMutationCallsites(`
    // db.prepare('DELETE FROM ignored');
    const text = "db.exec('DROP TABLE ignored')";
    const regex = /db\\.prepare\\('DELETE FROM ignored'\\)/;
    const multiline = \`
      db.prepare('DELETE FROM multiline_template_ignored').run();
    \`;
    db.prepare('INSERT OR IGNORE INTO events(event_id) VALUES(?)').run(id);
    store.db.prepare(\`UPDATE tasks SET status=? WHERE task_id=?\`).run(status, id);
    db.exec('CREATE TABLE IF NOT EXISTS sample(id TEXT); INSERT INTO sample VALUES(1);');
    db.prepare(sqlFromCaller).run();
    db.prepare(\`DELETE FROM tasks WHERE task_id=${'${'}taskId}\`).run();
    db.prepare('SELECT * FROM jobs').all();
    db.prepare('SELECT jobs.job_id FROM jobs JOIN tasks ON tasks.job_id=jobs.job_id').all();
  `, 'fixture.js');
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map(row => row.operationClass), [
    'data-write', 'data-write', 'multi-statement-unresolved', 'computed-or-unresolved', 'computed-or-unresolved', 'read', 'read'
  ]);
  assert.deepEqual(rows.slice(0, 3).map(row => row.objectName), ['events', 'tasks', 'sample']);
  assert.equal(rows[2].multiStatement, true);
  assert.deepEqual(rows[2].statementOperationClasses, ['schema-write', 'data-write']);
  assert.deepEqual(rows[5].referencedObjects, ['jobs']);
  assert.deepEqual(rows[6].referencedObjects, ['jobs', 'tasks']);
});

test('dynamic SQL template preserves static nested event-table references without scanning interpolation text', () => {
  const nested = scanSqlMutationCallsites(
    "db.prepare(`SELECT lease.lease_id FROM task_leases lease WHERE EXISTS (SELECT 1 FROM events event WHERE event.type='task.lease.quarantined' AND event.payload_json=${JSON.stringify({ leaseId })})`).get()",
    'fixture.js'
  );
  assert.equal(nested.length, 1);
  assert.equal(nested[0].classification, 'computed-or-unresolved');
  assert.equal(nested[0].operationClass, 'computed-or-unresolved');
  assert.equal(nested[0].sqlVerb, 'SELECT');
  assert.deepEqual(nested[0].referencedObjects, ['task_leases', 'events']);
  assert.match(nested[0].staticSql, /event\.type='task\.lease\.quarantined'/);

  const decoy = scanSqlMutationCallsites(
    'db.prepare(`SELECT * FROM task_leases WHERE marker=${"FROM events"}`).all()', 'fixture.js'
  );
  assert.equal(decoy.length, 1);
  assert.deepEqual(decoy[0].referencedObjects, ['task_leases'],
    'SQL-looking text inside interpolation must not become a referenced table');
});

test('direct SQL audit does not classify comments, strings, regex literals or method definitions as calls', () => {
  const rows = scanSqlMutationCallsites(`
    // db.prepare('DELETE FROM ignored');
    const value = "db.prepare('DELETE FROM ignored')";
    const pattern = /db\\.exec\\('DROP TABLE ignored'\\)/;
    const processName = /^Name:\\s*(.+)$/m.exec(status)?.[1] || null;
    const token = /([a-z]+)/g.exec(input)?.[1] || null;
    const division = x / db.exec('DELETE FROM tasks');
    const regexBody = /store.db.exec('DROP TABLE ignored')/.test(input);
    prepare(sql) { return sql; }
  `, 'fixture.js');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sqlArgument, "'DELETE FROM tasks'");
  assert.equal(rows[0].operationClass, 'data-write');
});

test('direct SQL audit masks regex literal bodies but retains division-followed database calls', () => {
  const source = [
    "const pattern = /store.db.exec('DROP TABLE ignored')/.test(input);",
    "const tickPattern = /`db.prepare('DROP TABLE ignored')`/.test(input);",
    "const result = x / db.exec('DELETE FROM tasks');"
  ].join('\n');
  const audit = scanSqlAuditFile(source, 'fixture.js');
  assert.equal(audit.rawTextualCandidateCount, 3);
  assert.equal(audit.callsites.length, 1);
  assert.equal(audit.callsites[0].operationClass, 'data-write');
  assert.equal(audit.unmatchedRawTextualCandidates.length, 2);
  assert.ok(audit.unmatchedRawTextualCandidates.every(item => item.maskReason === 'regex-literal'));
});

test('WITH-prefixed SQL remains unresolved instead of guessing read/write semantics', () => {
  const rows = scanSqlMutationCallsites("db.prepare('WITH q AS (SELECT 1) UPDATE tasks SET status=1').run()", 'fixture.js');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operationClass, 'with-clause-unresolved');
  assert.equal(rows[0].sqlVerb, 'WITH');
});

test('SQLite SAVEPOINT, RELEASE and END statements are classified as transaction control', () => {
  const rows = scanSqlMutationCallsites([
    "db.exec('SAVEPOINT scoped_change');",
    "db.exec('RELEASE SAVEPOINT scoped_change');",
    "db.exec('ROLLBACK TO SAVEPOINT scoped_change');",
    "db.exec('END TRANSACTION');"
  ].join('\n'), 'fixture.js');
  assert.deepEqual(rows.map(row => row.sqlVerb), ['SAVEPOINT', 'RELEASE', 'ROLLBACK', 'END']);
  assert.deepEqual(rows.map(row => row.operationClass), [
    'transaction-control', 'transaction-control', 'transaction-control', 'transaction-control'
  ]);
});

test('raw textual candidates masked as comments, strings or multiline templates remain enumerated', () => {
  const source = [
    "// db.prepare('DELETE FROM comment_only');",
    'const value = "db.exec(\'DROP TABLE string_only\')";',
    'const template = `',
    "  db.prepare('DELETE FROM template_only').run();",
    '`;',
    "const sql = `SELECT ${db.prepare('SELECT 1').get()}`;",
    'const multiReceiver = db',
    "  .prepare('SELECT * FROM multiline_receiver');",
    "db.prepare('SELECT * FROM live_table').all();"
  ].join('\n');
  const audit = scanSqlAuditFile(source, 'fixture.js');
  assert.equal(audit.rawTextualCandidateCount, 5);
  assert.equal(audit.callsites.length, 2);
  assert.equal(audit.unmatchedRawTextualCandidates.length, 3);
  assert.equal(audit.callsites[1].classification, 'literal-sql');
  assert.equal(audit.callsites[1].sqlVerb, 'SELECT');
  assert.equal(audit.multilineTextualCandidates.length, 1);
  assert.equal(audit.multilineTextualCandidates[0].classification, 'multiline-receiver-or-member-syntax-needs-manual-review');
  assert.deepEqual(audit.unmatchedRawTextualCandidates.map(row => row.maskReason), [
    'line-comment',
    'quoted-string',
    'template-literal-text'
  ]);
});

test('regex literals after block statements are masked without hiding executable calls after division', () => {
  const source = [
    'if (enabled) {} /store.db.exec(\'DROP TABLE ignored_if\')/.test(input);',
    'switch (kind) { case 1: break; default: break; } /db.prepare(\'DELETE FROM ignored_switch\')/.test(input);',
    "{ performCheck(); } /db.exec('DROP TABLE ignored_bare_block')/.test(input);",
    "const division = value / db.exec('DELETE FROM live_tasks');"
  ].join('\n');
  const audit = scanSqlAuditFile(source, 'fixture.js');
  assert.equal(audit.callsites.length, 1);
  assert.equal(audit.callsites[0].sqlArgument, "'DELETE FROM live_tasks'");
  assert.equal(audit.callsites[0].operationClass, 'data-write');
  assert.equal(audit.unmatchedRawTextualCandidates.length, 3);
  assert.ok(audit.unmatchedRawTextualCandidates.every(item => item.maskReason === 'regex-literal'));
});

test('regex/division boundaries distinguish function expressions, labelled blocks and optional catch blocks', () => {
  const source = [
    "const query = function () {} / db.exec('DELETE FROM live_after_function_expression');",
    "const asyncQuery = async function () {} / db.exec('DELETE FROM live_after_async_function_expression');",
    "const arrowQuery = (() => {}) / db.exec('DELETE FROM live_after_arrow_function_expression');",
    "const ClassExpression = class {} / db.exec('DELETE FROM live_after_class_expression');",
    "const objectExpression = { value: {} / db.exec('DELETE FROM live_after_object_expression') };",
    "function declaredFunction() {} /db.exec('DROP TABLE ignored_function_declaration')/.test(input);",
    "class DeclaredClass {} /db.exec('DROP TABLE ignored_class_declaration')/.test(input);",
    "label: {} /db.exec('DROP TABLE ignored_label')/.test(input);",
    "try {} catch {} /db.exec('DROP TABLE ignored_optional_catch')/.test(input);"
  ].join('\n');
  const audit = scanSqlAuditFile(source, 'fixture.js');
  assert.equal(audit.callsites.length, 5);
  assert.deepEqual(audit.callsites.map(row => row.sqlArgument), [
    "'DELETE FROM live_after_function_expression'", "'DELETE FROM live_after_async_function_expression'",
    "'DELETE FROM live_after_arrow_function_expression'", "'DELETE FROM live_after_class_expression'",
    "'DELETE FROM live_after_object_expression'"
  ]);
  assert.ok(audit.callsites.every(row => row.operationClass === 'data-write'));
  assert.equal(audit.unmatchedRawTextualCandidates.length, 4);
  assert.ok(audit.unmatchedRawTextualCandidates.every(item => item.maskReason === 'regex-literal'));
});

test('direct SQL audit accepts optional chaining and comments between receiver and member', () => {
  const source = [
    "db?.prepare('DELETE FROM tasks').run();",
    "db.prepare?.('UPDATE tasks SET status=1').run();",
    "db /* receiver comment */ .prepare('INSERT INTO jobs(job_id) VALUES(1)').run();",
    "db?.prepare?.('SELECT * FROM jobs').get();"
  ].join('\n');
  const audit = scanSqlAuditFile(source, 'fixture.js');
  assert.equal(audit.callsites.length, 4);
  assert.deepEqual(audit.callsites.map(row => row.operationClass), ['data-write', 'data-write', 'data-write', 'read']);
  assert.equal(audit.unmatchedRawTextualCandidates.length, 0);
});

test('multi-statement SQL exposes every verb and cannot be classified only by its first read', () => {
  const rows = scanSqlMutationCallsites([
    "db.exec('SELECT 1; DELETE FROM tasks WHERE task_id=1');",
    "db.exec('SELECT 1; UPDATE tasks SET status=\'failed\'; CREATE TABLE audit_log(id)');",
    "db.exec('SELECT 1; SELECT 2');",
    "db.exec(\"INSERT INTO logs(message) VALUES('a;b'); DELETE FROM logs\");"
  ].join('\n'), 'fixture.js');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].operationClass, 'multi-statement-unresolved');
  assert.deepEqual(rows[0].statementVerbs, ['SELECT', 'DELETE']);
  assert.deepEqual(rows[0].statementOperationClasses, ['read', 'data-write']);
  assert.equal(rows[0].containsMutation, true);
  assert.equal(rows[1].operationClass, 'multi-statement-unresolved');
  assert.deepEqual(rows[1].statementVerbs, ['SELECT', 'UPDATE', 'CREATE']);
  assert.deepEqual(rows[1].statementOperationClasses, ['read', 'data-write', 'schema-write']);
  assert.equal(rows[1].containsMutation, true);
  assert.equal(rows[2].operationClass, 'multi-statement-unresolved');
  assert.deepEqual(rows[2].statementVerbs, ['SELECT', 'SELECT']);
  assert.equal(rows[2].containsMutation, false);
  assert.deepEqual(rows[3].statementVerbs, ['INSERT', 'DELETE'], 'semicolons inside quoted SQL strings must not split statements');
  assert.deepEqual(rows[3].statementOperationClasses, ['data-write', 'data-write']);
});

test('RC.71 events schema bootstrap multi-statement call is schema-only, not an event writer', () => {
  const source = fs.readFileSync(new URL('../src/runtime/job-store.js', import.meta.url), 'utf8');
  const audit = scanSqlAuditFile(source, 'src/runtime/job-store.js');
  const bootstrap = audit.callsites.find(row => row.multiStatement &&
    row.sqlArgument.includes('CREATE TABLE IF NOT EXISTS events'));
  assert.ok(bootstrap, 'expected the one multi-statement events schema bootstrap');
  assert.equal(bootstrap.operationClass, 'multi-statement-unresolved', 'generic scanner retains conservative aggregate classification');
  assert.ok(bootstrap.statementDetails.length > 40);
  assert.ok(bootstrap.statementDetails.every(item => ['schema-write', 'transaction-control'].includes(item.operationClass)));
  assert.ok(bootstrap.statementDetails.some(item => item.objectName === 'events' && item.operationClass === 'schema-write'));
  assert.equal(bootstrap.statementDetails.filter(item => item.operationClass === 'data-write').length, 0);
  assert.match(bootstrap.sqlArgument, /CREATE TRIGGER IF NOT EXISTS agg_approval_security_events_no_update/);
  assert.match(bootstrap.sqlArgument, /CREATE TRIGGER IF NOT EXISTS agg_approval_reviewer_security_events_no_delete/);
});

test('event SQL query register v0.5.14 preserves nested/dynamic event references and historical hashes', () => {
  const historicalRegisterPath = 'docs/agg-external-checkpoint-v2-event-query-register-20261031-v0.5.7.json';
  const historicalInventoryPath = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261031T131500Z-v8.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, historicalRegisterPath))).digest('hex'),
    '95af5a64cdb86d82b850f030c135b3815bbf3d0e1d60daae88c8cfb7d8a63dd8',
    'v0.5.7 historical event-query register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, historicalInventoryPath))).digest('hex'),
    '2b9b792f6b96bfe3de1c5507d891908a123a59b99624e6c6166feec90b5072db',
    'v8 historical SQL inventory bytes are immutable');
  const v0_5_8Path = 'docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.8.json';
  const v9InventoryPath = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T090400Z-v9.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v0_5_8Path))).digest('hex'),
    'd2190e6eb5d6ffd721c77534a0d6e8dbb22556cf22d3a8994cf22031f17d3bfe',
    'superseded v0.5.8 query register bytes remain immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v9InventoryPath))).digest('hex'),
    '8f44f9b72bf917f1143926a31103db5b9b33e9c576ab96de891ef3d715a81650',
    'superseded v9 SQL inventory bytes remain immutable');
  const v0_5_9Path = 'docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.9.json';
  const v10InventoryPath = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T021528Z-v10.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v0_5_9Path))).digest('hex'),
    '41149223f9a198ba9e345899d82db7b855cc18f451f63a99ec32489261860679',
    'superseded v0.5.9 query register bytes remain immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v10InventoryPath))).digest('hex'),
    '509b78e6fab8852e95d0d838716eb0acc6bd6853b1b41ec09a861181271dda41',
    'superseded v10 SQL inventory bytes remain immutable');
  const v0_5_10RegisterPath = 'docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.10.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v0_5_10RegisterPath))).digest('hex'),
    '29a7c085116277c9c4393bbc6825003a9021004f9cfef43b0a6e640331227324',
    'v0.5.10 historical event-query register bytes are immutable');
  const v11InventoryPath = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T024303Z-v11.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v11InventoryPath))).digest('hex'),
    'ee7be7c9d3ca8b5d5d7a9fe3664891f6966e672ac35a7fbfe4a2b54e912f0672',
    'v11 historical SQL inventory bytes are immutable');
  const v0_5_11RegisterPath = 'docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.11.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v0_5_11RegisterPath))).digest('hex'),
    '14b72eb0ec5fe7ca34fef52a9f3f161dc27c7048f9ea96dde283216b449e1728',
    'v0.5.11 historical event-query register bytes are immutable');
  const v12InventoryPath = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T044931Z-v12.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v12InventoryPath))).digest('hex'),
    'bd8a12823b4c684763d6186b3a3076b66fa44763917bcc9975eedbdfc0cfdfae',
    'v12 historical SQL inventory bytes are immutable');
  const v13InventoryPath = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T051851Z-v13.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v13InventoryPath))).digest('hex'),
    '7eb0a5495c4af52c3df4e01774147da05bfb039071f2754fe7883aa15bb6ff5e',
    'v13 historical SQL inventory bytes are immutable');
  const v14InventoryPath = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T070000Z-v14.json';
  const v0_5_13RegisterPath = 'docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.13.json';
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v0_5_13RegisterPath))).digest('hex'),
    '6a5cd662a6cfde9177976ed0439cf7be8ffc4f4c6531cdff2491bab1a6b582da',
    'v0.5.13 predecessor event-query register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, v14InventoryPath))).digest('hex'),
    'f755504894ac0ed025949601b25481219b406eaeaa5bfb49a37eb5caa905a768',
    'v14 predecessor SQL inventory bytes are immutable');
  const inventoryPath = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261101T074005Z-v15.json';
  const register = buildEventQueryRegister(REPO_ROOT, inventoryPath,
    'agg-v2-event-query-register-20261101-v0.5.14');
  const versionedRegister = JSON.parse(fs.readFileSync(path.join(REPO_ROOT,
    'docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.14.json'), 'utf8'));
  const predecessorRegister = JSON.parse(fs.readFileSync(path.join(REPO_ROOT,
    v0_5_13RegisterPath), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT,
    'docs/agg-external-checkpoint-v2-event-query-register-20261101-v0.5.12.json'))).digest('hex'),
  '0d3fd07f457d0d86eb24956bd8b68e1a768445cb55de0ce4738b5be58b206112',
  'v0.5.12 predecessor event-query bytes remain immutable');
  assert.equal(versionedRegister.predecessorRegister, 'agg-v2-event-query-register-20261101-v0.5.13');
  assert.equal(versionedRegister.predecessorInventory, v14InventoryPath);
  assert.equal(versionedRegister.supersedes, 'agg-v2-event-query-register-20261101-v0.5.13');
  assert.match(versionedRegister.reviewNote, /ExecutionPersistenceStore v1.*provider-ledger-only writes/u);
  assert.equal(versionedRegister.sourceInventorySha256, register.sourceInventorySha256);
  assert.equal(versionedRegister.sourceInventory, inventoryPath);
  assert.deepEqual(register.counts, {
    eventSqlCallsites: 134,
    sourceFiles: 6,
    operations: { reader: 123, 'schema-bootstrap-only': 1, unresolved: 7, writer: 3 }
  });
  assert.equal(register.sourceInventorySha256, 'd1e6f1ff59046a77bff93b611837245617f3f4f90cba413bb05cd4f5d5cb3cb3');
  assert.deepEqual(register.sourceDrift, [], 'successor inventory must match every current runtime source file');
  assert.equal(versionedRegister.resolutionLineRebindings, 9);
  assert.match(register.sourceInventorySha256, /^[a-f0-9]{64}$/u);
  assert.equal(register.sourceInventorySha256, crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(REPO_ROOT, inventoryPath)))
    .digest('hex'));
  const stableQueryEntries = entries => entries.map(entry => {
    const { source, callerContext, ...rest } = entry;
    return { ...rest, source: { file: source.file, column: source.column },
      callerContext: callerContext ? { name: callerContext.name, resolution: callerContext.resolution } : null };
  });
  assert.deepEqual(stableQueryEntries(versionedRegister.entries), stableQueryEntries(predecessorRegister.entries),
    'all event query shapes and caller identities must remain stable across source line rebinding');
  assert.equal(new Set(register.entries.map(entry => `${entry.source.file}:${entry.source.line}:${entry.source.column}`)).size, 134);
  assert.ok(register.entries.every(entry => /^[a-f0-9]{64}$/u.test(entry.source.sourceSha256)));
  assert.ok(register.entries.filter(entry => entry.sqlSha256 !== null).every(entry => /^[a-f0-9]{64}$/u.test(entry.sqlSha256)));
  const unresolvedTemplateQueries = register.entries.filter(entry => entry.operation === 'unresolved');
  assert.equal(unresolvedTemplateQueries.length, 7);
  assert.ok(unresolvedTemplateQueries.every(entry => entry.operationClass === 'computed-or-unresolved' &&
    entry.sqlSha256 === null && /^[a-f0-9]{64}$/u.test(entry.staticSqlSha256) &&
    entry.referencedObjects.includes('events')),
  'dynamic SQL stays unresolved but preserves static event-table references');
  assert.equal(register.entries.filter(entry => entry.operation === 'schema-bootstrap-only').length, 1);
  assert.ok(register.entries.filter(entry => entry.operation === 'writer').every(entry => entry.operationClass === 'data-write'));
  assert.ok(register.entries.every(entry => entry.authorizationPurpose === 'pending-semantic-reader-review'));
  const bySite = (file, line) => register.entries.find(entry => entry.source.file === file && entry.source.line === line);
  assert.equal(bySite('src/runtime/adaptive-goal-approval-subsystem.js', 310).callerContext.name, 'assertFreshApprovalNonces');
  assert.equal(bySite('src/runtime/adaptive-goal-approval-subsystem.js', 344).callerContext.name, 'readApprovalPolicyHighWater');
  assert.equal(bySite('src/runtime/adaptive-goal-approval-subsystem.js', 436).transactionBoundary,
    'caller-requires-existing-transaction-by-runtime-check');
  const policyHighWaterSites = register.entries.filter(entry =>
    entry.callerContext?.name === 'recordAdaptiveGoalApprovalPolicyHighWater');
  assert.equal(policyHighWaterSites.length, 3);
  assert.ok(policyHighWaterSites.every(entry =>
    entry.transactionBoundary === 'caller-requires-existing-transaction-by-runtime-check'));
  assert.equal(bySite('src/runtime/adaptive-goal-reviewer-identity.js', 326).callerContext.name,
    'ingestAdaptiveGoalReviewerAttestation');
  assert.equal(bySite('src/runtime/adaptive-goal-reviewer-identity.js', 326).transactionBoundary,
    'explicit-transaction-markers-surround-query-in-direct-caller');
  assert.equal(bySite('src/runtime/job-store.js', 1126).callerContext.name, 'recordEvent');
  assert.ok(register.entries.every(entry => typeof entry.queryPurpose === 'string' && entry.queryPurpose.length > 0));
  assert.equal(register.entries.filter(entry => entry.eventTypeParameterized).length, 15);
  assert.equal(new Set(register.entries.flatMap(entry => entry.eventTypeLiterals)).size, 38);
  assert.ok(register.entries.filter(entry => entry.operation !== 'schema-bootstrap-only').every(entry => entry.callerContext?.name &&
    entry.callerContext.resolution === 'nearest-enclosing-declaration-by-source-layout-and-brace-balance'));
  assert.equal(bySite('src/runtime/job-store.js', 138).callerContext, null);
  assert.equal(bySite('src/runtime/job-store.js', 138).queryPurpose, 'event-schema-and-trigger-bootstrap');
  assert.equal(bySite('src/runtime/job-store.js', 1126).queryPurpose, 'event-row-insert');
  const nestedEventRead = bySite('src/runtime/workflow-state-predicates.js', 58);
  assert.equal(nestedEventRead.operation, 'unresolved', 'dynamic SQL must not be promoted to a fully classified reader');
  assert.deepEqual(nestedEventRead.referencedObjects, ['task_leases', 'events']);
  assert.deepEqual(nestedEventRead.eventTypeLiterals, ['task.lease.quarantined']);
  assert.match(nestedEventRead.staticSqlSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(bySite('src/runtime/adaptive-goal-approval-subsystem.js', 427).predicateColumns, ['event_id']);
  for (const purpose of ['event-existence-check', 'event-identity-lookup-or-readback', 'event-row-count',
    'latest-event-or-latest-matching-event', 'nonce-replay-count']) {
    assert.ok(register.entries.some(entry => entry.queryPurpose === purpose), `expected query-purpose category ${purpose}`);
  }
  assert.ok(register.entries.every(entry => [
    'caller-requires-existing-transaction-by-runtime-check',
    'explicit-transaction-markers-surround-query-in-direct-caller',
    'no-complete-transaction-bracket-observed-in-direct-caller',
    'direct-caller-context-unresolved'
  ].includes(entry.transactionBoundary)));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-v2-query-register-drift-'));
  try {
    const sourcePaths = [...new Set(register.entries.map(entry => entry.source.file))];
    for (const relative of [...new Set([register.sourceInventory, register.configuredEntrypoint, ...sourcePaths])]) {
      const target = path.join(tempRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, relative), target);
    }
    const entrypointPath = path.join(tempRoot, register.configuredEntrypoint);
    fs.appendFileSync(entrypointPath,
      "\nfunction __queryRegisterEntrypointDriftProbe(db) { return db.prepare('SELECT event_id FROM events WHERE event_id=?').get('probe'); }\n");
    const drifted = buildEventQueryRegister(tempRoot, register.sourceInventory, register.registerId);
    assert.equal(drifted.counts.eventSqlCallsites, 135);
    assert.equal(drifted.sourceDrift.length, 1);
    assert.equal(drifted.sourceDrift[0].file, register.configuredEntrypoint);
    const preservedRows = register.entries.filter(entry => entry.source.file !== register.configuredEntrypoint);
    const reusedRows = drifted.entries.filter(entry => entry.source.file !== register.configuredEntrypoint);
    assert.deepEqual(reusedRows, preservedRows,
      'unchanged non-entrypoint runtime files must reuse the preserved inventory rows exactly');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
