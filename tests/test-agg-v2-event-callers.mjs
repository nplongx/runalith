import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory, scanRecordEventCallsites } from '../scripts/audit-agg-v2-event-callers.mjs';
import { scanSqlAuditFile } from '../scripts/audit-agg-v2-sql-mutation-callers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('recordEvent inventory scans template interpolation and multiline members while masking regex and template text', () => {
  const source = [
    "const regex = /store.recordEvent(jobId, 'fake.regex', {})/;",
    "const string = \"store.recordEvent(jobId, 'fake.string', {})\";",
    "const templateText = `store.recordEvent(jobId, 'fake.template', {})`;",
    "const interpolated = `${store.recordEvent(jobId, 'template.interpolated', {})}`;",
    "store /* receiver */ ?. recordEvent(jobId, 'multiline.comment', { nested: [1, 2] });",
    "store.recordEvent(jobId,\n  'multiline.call',\n  { nested: [1, 2] });",
    "recordEvent(jobId, type, payload) { return true; }"
  ].join('\n');

  const rows = scanRecordEventCallsites(source, 'fixture.js');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.literalEventType), [
    'template.interpolated', 'multiline.comment', 'multiline.call'
  ]);
  assert.deepEqual(rows.map(row => row.line), [4, 5, 6]);
});

test('recordEvent inventory retains computed event types inside template interpolation', () => {
  const source = "const result = `${store.recordEvent(jobId, eventType, payload)}`;";
  const rows = scanRecordEventCallsites(source, 'fixture.js');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, 'computed-or-unresolved');
  assert.equal(rows[0].eventTypeArgument, 'eventType');
});

test('recordEvent inventory detects a valid source mutation but ignores comment/string/regex decoys', () => {
  const baseline = scanRecordEventCallsites("store.recordEvent(jobId, 'workflow.transition', {});", 'fixture.js');
  const mutated = scanRecordEventCallsites([
    "// store.recordEvent(jobId, 'workflow.transition', {});",
    'const text = "store.recordEvent(jobId, \'fake.string\', {})";',
    "const pattern = /store.recordEvent(jobId, 'fake.regex', {})/;",
    "store.recordEvent(jobId, 'workflow.failed', {});"
  ].join('\n'), 'fixture.js');
  assert.equal(baseline.length, 1);
  assert.equal(mutated.length, 1);
  assert.equal(mutated[0].literalEventType, 'workflow.failed');
  assert.notDeepEqual(mutated, baseline, 'a real event-type mutation must alter the inventory');
});

test('recordEvent inventory handles nested templates, multiline member syntax and regex after blocks', () => {
  const source = [
    "if (ready) /store.recordEvent(jobId, 'fake.after.if', {})/.test(input);",
    "while (ready) /store.recordEvent(jobId, 'fake.after.while', {})/.test(input);",
    "if (ready) { run(); } /store.recordEvent(jobId, 'fake.after.block', {})/.test(input);",
    "class Example {} /store.recordEvent(jobId, 'fake.after.class', {})/.test(input);",
    "{ run(); } /store.recordEvent(jobId, 'fake.after.bare.block', {})/.test(input);",
    'const quotient = left / right / divisor;',
    'const nested = `${outer(`${store.recordEvent(jobId, \'nested.template\', {})}`)}`;',
    'store',
    '  ?.recordEvent',
    '  (jobId,',
    "   'split.receiver.member.paren',",
    '   { ok: true });',
    'store.',
    '  recordEvent(jobId,',
    "    'split.member', {});",
    'store.recordEvent',
    '  (jobId,',
    "   'split.open.paren', {});"
  ].join('\n');
  const rows = scanRecordEventCallsites(source, 'fixture.js');
  assert.deepEqual(rows.map(row => row.literalEventType), [
    'nested.template', 'split.receiver.member.paren', 'split.member', 'split.open.paren'
  ]);
  assert.deepEqual(rows.map(row => row.line), [7, 8, 13, 16]);
});

test('recordEvent inventory handles optional calls and comments around literal event arguments', () => {
  const source = [
    "store?.recordEvent?.(jobId, /* comment, */ 'optional.member.and.call', {});",
    "store.recordEvent?.(jobId, // comment before event literal",
    "  'optional.call', {});",
    "store.recordEvent(jobId, /* leading */ 'comment.leading', {});"
  ].join('\n');
  const rows = scanRecordEventCallsites(source, 'fixture.js');
  assert.deepEqual(rows.map(row => row.literalEventType), [
    'optional.member.and.call', 'optional.call', 'comment.leading'
  ]);
});

test('recordEvent inventory treats CR, LF and CRLF as JavaScript line terminators', () => {
  const source = [
    "// CR-only comment before call\rstore.recordEvent(jobId, 'after.cr', {});",
    "store.recordEvent(jobId, // CR-only argument comment\r 'cr.argument', {});",
    "// CRLF comment\r\nstore.recordEvent(jobId, 'after.crlf', {});"
  ].join('\r');
  const rows = scanRecordEventCallsites(source, 'fixture.js');
  assert.deepEqual(rows.map(row => row.literalEventType), ['after.cr', 'cr.argument', 'after.crlf']);
  assert.deepEqual(rows.map(row => row.line), [2, 3, 6]);
});

test('recordEvent inventory masks regex after labels, switch cases and ASI statements', () => {
  const source = [
    "label: {} /store.recordEvent(id, 'fake.labeled', {})/.test(input);",
    "switch (value) { case 1: {} /store.recordEvent(id, 'fake.case', {})/.test(input); break; default: {} /store.recordEvent(id, 'fake.default', {})/.test(input); }",
    "while (ready) { break\n/store.recordEvent(id, 'fake.break', {})/.test(input); }",
    "while (ready) { continue\n/store.recordEvent(id, 'fake.continue', {})/.test(input); }",
    "debugger\n/store.recordEvent(id, 'fake.debugger', {})/.test(input);",
    "store.recordEvent(id, 'real.after.regex', {});"
  ].join('\n');
  const rows = scanRecordEventCallsites(source, 'fixture.js');
  assert.deepEqual(rows.map(row => row.literalEventType), ['real.after.regex']);
});

test('recordEvent inventory masks regex literals in export-default expressions', () => {
  const source = [
    "export default /store.recordEvent(id, 'fake.export.default', {})/;",
    "store.recordEvent(id, 'real.export.default.followup', {});"
  ].join('\n');
  const rows = scanRecordEventCallsites(source, 'fixture.mjs');
  assert.deepEqual(rows.map(row => row.literalEventType), ['real.export.default.followup']);
});

test('recordEvent source callsites match reviewed V2-01 successor register without rewriting historical baselines', () => {
  const historicalRegisterPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261031-v0.5.9.json');
  const historicalInventoryPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261031-v0.5.9.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(historicalRegisterPath)).digest('hex'),
    'b5707b2ba88a7f84ab85593e3ea59df62f6e0ede7d426f5b84c8cb5697d7ed7d',
    'v0.5.9 historical event-caller register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(historicalInventoryPath)).digest('hex'),
    '0eb2af8f163e633d63b516e4b97bec9a46f241ebbf43d91ac0bcaf49e0d68447',
    'v0.5.9 historical event-caller inventory bytes are immutable');
  const predecessorRegisterPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.10.json');
  const predecessorInventoryPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.10.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(predecessorRegisterPath)).digest('hex'),
    'b73666fdf86a44d528d27a00e707b20445c091dbb5b636345d0ee9555d0b248c',
    'v0.5.10 predecessor event-caller register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(predecessorInventoryPath)).digest('hex'),
    '1635a4a7bf5a3e0799d7873a4d394f40b041f458bdf2991419c2da3df57af65d',
    'v0.5.10 predecessor event-caller inventory bytes are immutable');
  const latestHistoricalRegisterPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.11.json');
  const latestHistoricalInventoryPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.11.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(latestHistoricalRegisterPath)).digest('hex'),
    'e3e9339da85d81110d54788445d8a5380e3bee80bb3c5f14eba255f7e72d52d6',
    'v0.5.11 historical event-caller register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(latestHistoricalInventoryPath)).digest('hex'),
    '759603c89e965b6d184ea781cb50ab4f613097d120ea8c89a8f08afc61f2c2f7',
    'v0.5.11 historical event-caller inventory bytes are immutable');
  const previousRegisterPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.12.json');
  const previousInventoryPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.12.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(previousRegisterPath)).digest('hex'),
    '05f1b599f8c47d4ad9cd9626e860a74a6c2d853042a7dfc209e475387edf7eaf',
    'v0.5.12 historical event-caller register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(previousInventoryPath)).digest('hex'),
    '5e61bafae09d360bf550db5f98c03cb9836e9e73014370c015c25e8a5787ce3f',
    'v0.5.12 historical event-caller inventory bytes are immutable');
  const v0_5_13RegisterPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.13.json');
  const v0_5_13InventoryPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.13.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v0_5_13RegisterPath)).digest('hex'),
    '3f1ee97bf5073a2b4ecb899e3131886209dd3433748a670e6dafd7d042241aaf',
    'v0.5.13 historical event-caller register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v0_5_13InventoryPath)).digest('hex'),
    '242ee3a5564ba62e84f33e89c20fa8bcc6a4239130de05fc7339777f0c7762e2',
    'v0.5.13 historical event-caller inventory bytes are immutable');
  const v0_5_14RegisterPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.14.json');
  const v0_5_14InventoryPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.14.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v0_5_14RegisterPath)).digest('hex'),
    '8fc3428891b4dc4323f22100799376159344f0772e2c5c70c193ab89ba9d604d',
    'v0.5.14 predecessor event-caller register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v0_5_14InventoryPath)).digest('hex'),
    'e6c141df0bc3c37518f96b581b04a7780ee1bf5ee0743145b1f42846873265ff',
    'v0.5.14 predecessor event-caller inventory bytes are immutable');
  const v0_5_15RegisterPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.15.json');
  const v0_5_15InventoryPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.15.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v0_5_15RegisterPath)).digest('hex'),
    '5032b44381093325486488c6a9ab65bd27c53c43e06fc4230ed1509509f0502a',
    'v0.5.15 predecessor event-caller register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v0_5_15InventoryPath)).digest('hex'),
    '3391a2cb3611dd72081ae15588830cd5e2448aea09104ad47d69e9db56e8ce32',
    'v0.5.15 predecessor event-caller inventory bytes are immutable');
  const v0_5_16RegisterPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.16.json');
  const v0_5_16InventoryPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.16.json');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v0_5_16RegisterPath)).digest('hex'),
    'b0d98e129dfc7a3e81b8e6a1b51f7e21ac29bf93b30b402952f3546923bb966a',
    'v0.5.16 predecessor event-caller register bytes are immutable');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(v0_5_16InventoryPath)).digest('hex'),
    'bf59b53028cd4b605b5b47b17434fdd9f9d980fb0a110f37556c19efe283e78e',
    'v0.5.16 predecessor event-caller inventory bytes are immutable');
  const predecessor = JSON.parse(fs.readFileSync(v0_5_13RegisterPath, 'utf8'));
  const registerPath = path.join(ROOT, 'docs/agg-external-checkpoint-v2-record-event-caller-register-20261101-v0.5.17.json');
  const register = JSON.parse(fs.readFileSync(registerPath, 'utf8'));
  const inventory = buildInventory(ROOT);
  assert.equal(register.status, 'source-callsite-drift-baseline-not-authorization-registry');
  assert.equal(register.configuredEntrypoint, inventory.configuredEntrypoint);
  assert.deepEqual(register.sourceFiles, inventory.fileSummaries,
    'any source-file byte change requires an explicit inventory review and register successor');
  assert.equal(register.predecessorRegister, 'agg-v2-record-event-caller-register-20261101-v0.5.16');
  assert.equal(register.predecessorInventory, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.16.json');
  assert.equal(register.supersedes, 'agg-v2-record-event-caller-register-20261101-v0.5.16');
  assert.match(register.reviewNote, /provider-ledger-only.*shared SQLite connection/u);
  assert.equal(register.resolutionLineRebindings, 0);
  const stableCallsites = rows => rows.map(({ file, jobIdArgument, eventTypeArgument, classification, literalEventType }) => ({
    file, jobIdArgument, eventTypeArgument, classification, literalEventType
  }));
  const priorMap = new Map(stableCallsites(predecessor.callsites).map(row => [JSON.stringify(row), row]));
  const currentMap = new Map(stableCallsites(register.callsites).map(row => [JSON.stringify(row), row]));
  const removed = stableCallsites(predecessor.callsites).filter(row => !currentMap.has(JSON.stringify(row)));
  const added = stableCallsites(register.callsites).filter(row => !priorMap.has(JSON.stringify(row)));
  assert.equal(removed.length, 1, 'only one event callsite may move to its Workflow owner');
  assert.equal(added.length, 1, 'only one event callsite may move to its Workflow owner');
  assert.deepEqual(removed[0], {
    file: 'src/runtime/execution-manager.js', jobIdArgument: 'task.job_id',
    eventTypeArgument: "'execution.spawn_authorized'", classification: 'literal', literalEventType: 'execution.spawn_authorized'
  });
  assert.deepEqual(added[0], {
    file: 'src/runtime/workflow-state-port.js', jobIdArgument: 'jobId',
    eventTypeArgument: "'execution.spawn_authorized'", classification: 'literal', literalEventType: 'execution.spawn_authorized'
  });
  const removedKeys = new Set(removed.map(JSON.stringify));
  const addedKeys = new Set(added.map(JSON.stringify));
  const unchangedPrior = stableCallsites(predecessor.callsites).filter(row => !removedKeys.has(JSON.stringify(row))).map(JSON.stringify).sort();
  const unchangedCurrent = stableCallsites(register.callsites).filter(row => !addedKeys.has(JSON.stringify(row))).map(JSON.stringify).sort();
  assert.deepEqual(unchangedCurrent, unchangedPrior, 'all other RecordEvent callsites remain identical');
  const computedGroups = rows => {
    const groups = new Map();
    for (const row of rows.filter(item => item.classification !== 'literal')) {
      const key = JSON.stringify([row.file, row.jobIdArgument, row.eventTypeArgument, row.classification, row.literalEventType]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const group of groups.values()) group.sort((a, b) => a.line - b.line);
    return groups;
  };
  const priorComputed = computedGroups(predecessor.callsites);
  for (const [key, currentRows] of computedGroups(register.callsites)) {
    const priorRows = priorComputed.get(key);
    assert.equal(currentRows.length, priorRows.length);
    currentRows.forEach((row, index) => {
      assert.deepEqual(register.computedProducerResolutions[`${row.file}:${row.line}`],
        predecessor.computedProducerResolutions[`${priorRows[index].file}:${priorRows[index].line}`],
        'computed producer review must survive source line rebinding unchanged');
    });
  }
  assert.equal(register.sourceInventory, 'docs/agg-external-checkpoint-v2-record-event-caller-inventory-20261101-v0.5.17.json');
  const sourceInventoryBytes = fs.readFileSync(path.join(ROOT, register.sourceInventory));
  assert.equal(register.sourceInventorySha256, crypto.createHash('sha256').update(sourceInventoryBytes).digest('hex'));
  const callsitesFor = file => register.sourceFiles.find(row => row.file === file)?.recordEventCallsites;
  assert.equal(callsitesFor('src/runtime/job-store.js'), 64);
  assert.equal(callsitesFor('src/runtime/agent-session-store.js'), 15);
  assert.equal(callsitesFor(register.configuredEntrypoint), 9);
  assert.equal(callsitesFor('src/runtime/workflow/case01-snapshot-service.js'), 2);
  assert.equal(callsitesFor('src/runtime/workspace-write-capability-service.js'), 1);
  assert.equal(callsitesFor('src/runtime/execution-persistence-participant.js'), 0);
  assert.equal(callsitesFor('src/runtime/execution-persistence-store.js'), 0);
  assert.equal(callsitesFor('src/runtime/workflow-control-port.js'), 0);
  assert.equal(callsitesFor('src/runtime/workflow-plan-public-api.js'), 0);
  assert.equal(callsitesFor('src/runtime/execution-manager.js'), 2);
  assert.equal(callsitesFor('src/runtime/workflow-state-port.js'), 1);
  assert.equal(register.callsites.filter(row => row.file === 'src/runtime/execution-manager.js' &&
    row.literalEventType === 'execution.spawn_authorized').length, 0);
  assert.equal(register.callsites.filter(row => row.file === 'src/runtime/workflow-state-port.js' &&
    row.literalEventType === 'execution.spawn_authorized').length, 1);
  assert.equal(register.sourceFiles.length, 108);
  assert.deepEqual(register.counts, {
    callsiteCount: inventory.callsiteCount,
    literalCallsiteCount: inventory.literalCallsiteCount,
    computedOrUnresolvedCallsiteCount: inventory.computedOrUnresolvedCallsiteCount,
    distinctLiteralEventTypeCount: inventory.distinctLiteralEventTypeCount
  });
  assert.deepEqual(register.callsites, inventory.callsites.map(row => ({
    file: row.file, line: row.line, jobIdArgument: row.jobIdArgument,
    eventTypeArgument: row.eventTypeArgument, classification: row.classification,
    literalEventType: row.literalEventType
  })), 'new, removed, moved or changed recordEvent callsites require manual register review');

  const computed = inventory.callsites.filter(row => row.classification !== 'literal');
  const computedKeys = computed.map(row => `${row.file}:${row.line}`).sort();
  assert.deepEqual(Object.keys(register.computedProducerResolutions).sort(), computedKeys,
    'every computed/caller-supplied event expression must have an explicit resolution record');
  const scannedSource = inventory.fileSummaries.map(file => fs.readFileSync(path.join(ROOT, file.file), 'utf8')).join('\n');
  for (const row of computed) {
    const resolution = register.computedProducerResolutions[`${row.file}:${row.line}`];
    assert.ok(resolution.status && resolution.note, `${row.file}:${row.line} needs a review status and explanation`);
    assert.ok(Array.isArray(resolution.eventTypes) && resolution.eventTypes.length > 0,
      `${row.file}:${row.line} needs observed branch values or an explicit bounded set`);
    for (const eventType of resolution.eventTypes) {
      assert.ok(scannedSource.includes(eventType), `${row.file}:${row.line} resolution value is absent from scanned source: ${eventType}`);
    }
  }
  assert.equal(register.literalEventTypes.length, inventory.distinctLiteralEventTypeCount);
  assert.deepEqual(register.literalEventTypes.map(row => row.eventType).sort(), inventory.distinctLiteralEventTypes);
  assert.ok(register.literalEventTypes.every(row => row.projectionClassification === 'pending-query-reader-writer-review' &&
    row.payloadSchema === 'not-defined'), 'literal producers must not be mistaken for reviewed projection semantics');
  assert.equal(register.computedProducerResolutions['src/runtime/job-store.js:1198'].status, 'unbounded-public-parameter');
  assert.match(register.reviewNote, /WorkflowStatePort v2/u,
    'successor must record the Workflow-owned atomic spawn authorization move');

  const workflowStoreSource = fs.readFileSync(path.join(ROOT, 'src/runtime/job-store.js'), 'utf8');
  const recordEventMethod = workflowStoreSource.match(/recordEvent\(jobId, type, payload = \{\}, dedupeKey = ''\) \{[\s\S]*?INSERT OR IGNORE INTO events/u);
  assert.ok(recordEventMethod, 'canonical WorkflowStore.recordEvent writer must remain identifiable');
  const canonicalInsertOffset = recordEventMethod[0].lastIndexOf('INSERT OR IGNORE INTO events');
  const canonicalInsertLine = workflowStoreSource.slice(0, recordEventMethod.index + canonicalInsertOffset).split(/\r?\n/u).length;
  const directEventInserts = inventory.fileSummaries.flatMap(file => {
    const source = fs.readFileSync(path.join(ROOT, file.file), 'utf8');
    if (!/\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+events\b/i.test(source)) return [];
    return scanSqlAuditFile(source, file.file).callsites
      .filter(row => row.operationClass === 'data-write' && row.referencedObjects.includes('events') &&
        /^\s*[`'\"]?\s*INSERT\b/i.test(row.sqlArgument))
      .map(row => ({ file: row.file, line: row.line, api: row.api, sqlVerb: row.sqlVerb, table: row.objectName }));
  }).filter(row => !(row.file === 'src/runtime/job-store.js' && row.line === canonicalInsertLine));
  assert.deepEqual(directEventInserts, register.directSqlEventWriters.map(({ file, line, api, sqlVerb, table }) =>
    ({ file, line, api, sqlVerb, table })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  'direct INSERT writers to events outside recordEvent() must be enumerated separately');
  assert.equal(register.directSqlEventWriters.length, 2);
  for (const writer of register.directSqlEventWriters) {
    const source = fs.readFileSync(path.join(ROOT, writer.file), 'utf8');
    const lines = source.split(/\r?\n/);
    assert.ok(source.includes(writer.eventType), `${writer.file} must contain its recorded event type`);
    assert.ok(lines[writer.constantDeclarationLine - 1]?.includes(writer.constantDeclaration),
      `${writer.file}:${writer.constantDeclarationLine} event constant must match the recorded type`);
    assert.ok(lines[writer.line - 1]?.includes('.prepare('), `${writer.file}:${writer.line} must be the recorded SQL prepare call`);
    assert.ok(lines[writer.writerBindingLine - 1]?.trim().startsWith('.run(') &&
      lines[writer.writerBindingLine - 1].includes(writer.writerBindingEvidence),
    `${writer.file}:${writer.writerBindingLine} adjacent SQL run must bind the recorded event constant`);
    assert.ok(source.includes(writer.readerEvidence), `${writer.file} must retain the recorded event reader/replay check`);
    assert.ok(lines[writer.readbackLine - 1]?.includes(writer.readbackEvidence),
      `${writer.file}:${writer.readbackLine} must retain the recorded readback/verifier seam`);
    assert.ok(Array.isArray(writer.readerQueries) && writer.readerQueries.length > 0,
      `${writer.file} must enumerate query-level event readers`);
    for (const reader of writer.readerQueries) {
      const queryAndBinding = lines.slice(reader.queryLine - 1, reader.bindingLine).join('\n');
      assert.ok(queryAndBinding.includes(reader.querySourceEvidence), `${writer.file}:${reader.queryLine} reader query changed: ${reader.purpose}`);
      assert.ok(lines[reader.bindingLine - 1]?.includes(reader.bindingEvidence),
        `${writer.file}:${reader.bindingLine} reader binding changed: ${reader.purpose}`);
    }
    assert.ok(writer.classification === 'anti-replay-and-execution-authorization' && writer.reader && writer.writer && writer.note);
  }
});
