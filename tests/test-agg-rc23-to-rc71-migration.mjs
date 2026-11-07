import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'dist/runalith-1.0.9-rc.23-actionable-source-mismatch-recovery-20261028.mcpb');
const BASELINE_SHA256 = '00804c9599454533a45418c7fe733a3ced85b07219dee71c02eb19bcc0dbdd3e';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function runStore({ cwd, database, dataDir, workspace, source, expectedJobId = '' }) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, WORKFLOW_DB: database, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: workspace, EXPECTED_JOB_ID: expectedJobId },
    maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const inspectAndSeed = `
  import crypto from 'node:crypto';
  const { workflowStore: store } = await import('./src/runtime/job-store.js');
  const job = store.createJob({ conversationKey: 'rc23-to-rc71-migration-acceptance', title: 'Immutable RC.23 migration fixture' });
  store.recordEvent(job.job_id, 'migration.fixture.rc23', { source: 'immutable-rc23-archive', ordinal: 1 }, 'rc23-migration-fixture');
  const schema = store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const result = { jobId: job.job_id, schemaSha256: crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
    tableCount: schema.filter(row => row.type === 'table').length,
    indexCount: schema.filter(row => row.type === 'index').length,
    triggerCount: schema.filter(row => row.type === 'trigger').length };
  store.db.close();
  process.stdout.write(JSON.stringify(result) + '\\n');
`;

const inspectMigrated = `
  import crypto from 'node:crypto';
  const { workflowStore: store } = await import('./job-store.js');
  const job = store.db.prepare('SELECT job_id,title FROM jobs WHERE job_id=?').get(process.env.EXPECTED_JOB_ID);
  const events = store.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='migration.fixture.rc23'").all(process.env.EXPECTED_JOB_ID);
  const schema = store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const result = { job, events, schemaSha256: crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
    tableCount: schema.filter(row => row.type === 'table').length,
    indexCount: schema.filter(row => row.type === 'index').length,
    triggerCount: schema.filter(row => row.type === 'trigger').length,
    foreignKeys: store.db.prepare('PRAGMA foreign_keys').get().foreign_keys,
    synchronous: store.db.prepare('PRAGMA synchronous').get().synchronous,
    journalMode: store.db.prepare('PRAGMA journal_mode').get().journal_mode };
  store.db.close();
  process.stdout.write(JSON.stringify(result) + '\\n');
`;

test('RC.23 historical WorkflowStore database opens and survives RC.71 restart', t => {
  assert.ok(fs.existsSync(BASELINE), `missing immutable historical baseline: ${BASELINE}`);
  assert.equal(sha256(fs.readFileSync(BASELINE)), BASELINE_SHA256, 'historical RC.23 archive identity changed');
  execFileSync('unzip', ['-t', BASELINE], { cwd: ROOT, stdio: 'pipe' });
  const archivePaths = execFileSync('unzip', ['-Z1', BASELINE], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.ok(archivePaths.includes('src/runtime/job-store.js'), 'historical archive must contain its packaged WorkflowStore entry');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-rc23-rc71-migration-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.chmodSync(temporaryRoot, 0o700);
  const oldRoot = path.join(temporaryRoot, 'rc23');
  const workspace = path.join(temporaryRoot, 'workspace');
  const database = path.join(temporaryRoot, 'workflow.db');
  fs.mkdirSync(oldRoot, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  execFileSync('unzip', ['-q', BASELINE, '-d', oldRoot], { cwd: ROOT, stdio: 'pipe' });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(oldRoot, 'node_modules'), 'dir');

  const historical = runStore({ cwd: oldRoot, database, dataDir: temporaryRoot, workspace, source: inspectAndSeed });
  assert.match(historical.jobId, /^job_[a-f0-9-]{36}$/);
  assert.ok(historical.tableCount > 0);
  const migrated = runStore({ cwd: ROOT, database, dataDir: temporaryRoot, workspace,
    source: inspectMigrated, expectedJobId: historical.jobId });
  const restarted = runStore({ cwd: ROOT, database, dataDir: temporaryRoot, workspace,
    source: inspectMigrated, expectedJobId: historical.jobId });

  for (const state of [migrated, restarted]) {
    assert.equal(state.job?.job_id, historical.jobId, 'historical job row was not preserved');
    assert.equal(state.events.length, 1, 'historical event was lost or duplicated');
    assert.equal(state.events[0].job_id, historical.jobId);
    assert.equal(state.events[0].payload_json, '{"source":"immutable-rc23-archive","ordinal":1}');
    assert.equal(state.foreignKeys, 1);
    assert.equal(state.synchronous, 2, 'WorkflowStore must use SQLite synchronous=FULL');
    assert.equal(state.journalMode, 'wal');
  }
  assert.equal(restarted.schemaSha256, migrated.schemaSha256, 'RC.71 schema changed across repeated startup');
  assert.equal(restarted.tableCount, migrated.tableCount);
  assert.equal(restarted.indexCount, migrated.indexCount);
  assert.equal(restarted.triggerCount, migrated.triggerCount);
});
