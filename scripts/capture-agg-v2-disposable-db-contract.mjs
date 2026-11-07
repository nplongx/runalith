#!/usr/bin/env node
/**
 * Reproducible, disposable SQLite startup/restart readback for RC.71 source.
 * No caller-supplied database path is accepted: all SQLite files are created
 * under a fresh mode-0700 OS temporary directory and removed in finally.
 * This does not inspect or mutate any deployed/production database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_SOURCE = path.join(ROOT, 'src/runtime/job-store.js');
const TRUST_SOURCE = path.join(ROOT, 'src/runtime/adaptive-goal-trust-configuration.js');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function pragma(db, name) {
  const allowed = new Set(['foreign_keys', 'synchronous', 'busy_timeout', 'locking_mode', 'journal_mode', 'user_version', 'application_id']);
  if (!allowed.has(name)) throw new Error(`unsupported PRAGMA ${name}`);
  const row = db.prepare(`PRAGMA ${name}`).get();
  // node:sqlite exposes PRAGMA busy_timeout's result column as `timeout`.
  return row[name] ?? (name === 'busy_timeout' ? row.timeout : undefined);
}

function schemaSummary(db) {
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  const canonical = JSON.stringify(objects.map(row => ({
    type: row.type, name: row.name, table: row.tbl_name, sql: row.sql
  })));
  return {
    tableCount: objects.filter(row => row.type === 'table').length,
    objectCount: objects.length,
    schemaSha256: sha256(canonical)
  };
}

function snapshot(db, label) {
  return {
    label,
    pragmas: {
      foreign_keys: pragma(db, 'foreign_keys'),
      synchronous: pragma(db, 'synchronous'),
      busy_timeout: pragma(db, 'busy_timeout'),
      locking_mode: pragma(db, 'locking_mode'),
      journal_mode: pragma(db, 'journal_mode'),
      user_version: pragma(db, 'user_version'),
      application_id: pragma(db, 'application_id')
    },
    schema: schemaSummary(db)
  };
}

function loadFreshWorkflowModule(cycle) {
  const url = `${pathToFileURL(WORKFLOW_SOURCE).href}?disposable-contract-cycle=${cycle}`;
  return import(url);
}

async function capture() {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-agg-v2-disposable-'));
  const workflowPath = path.join(privateDir, 'workflow.db');
  const trustPath = path.join(privateDir, 'agg-trust-configuration.db');
  const previousEnv = {
    WORKFLOW_DATA_DIR: process.env.WORKFLOW_DATA_DIR,
    WORKFLOW_DB: process.env.WORKFLOW_DB
  };
  let workflowStore = null;
  let trustDb = null;
  let workflowCycle2 = null;
  let trustDbCycle2 = null;
  try {
    // Keep permission hardening inside the cleanup scope: even if chmod fails,
    // the just-created empty directory is still removed by finally below.
    fs.chmodSync(privateDir, 0o700);
    process.env.WORKFLOW_DATA_DIR = privateDir;
    process.env.WORKFLOW_DB = workflowPath;

    const workflowRuntime = await loadFreshWorkflowModule(1);
    workflowStore = workflowRuntime.workflowStore;
    assert.equal(path.resolve(workflowRuntime.WORKFLOW_DB_PATH), workflowPath);

    const trustRuntime = await import(pathToFileURL(TRUST_SOURCE).href);
    trustDb = new DatabaseSync(trustPath);
    trustRuntime.initializeAdaptiveGoalTrustConfigurationLedger(trustDb);

    const firstWorkflow = snapshot(workflowStore.db, 'first-source-initialization');
    const firstTrust = snapshot(trustDb, 'first-source-initialization');

    workflowStore.db.close();
    workflowStore = null;
    trustDb.close();
    trustDb = null;

    // Re-importing the module with a distinct URL re-executes the production
    // startup DDL/migration code against the same disposable existing DB.
    const workflowRuntimeCycle2 = await loadFreshWorkflowModule(2);
    workflowCycle2 = workflowRuntimeCycle2.workflowStore;
    assert.equal(path.resolve(workflowRuntimeCycle2.WORKFLOW_DB_PATH), workflowPath);
    trustDbCycle2 = new DatabaseSync(trustPath);
    trustRuntime.initializeAdaptiveGoalTrustConfigurationLedger(trustDbCycle2);

    const secondWorkflow = snapshot(workflowCycle2.db, 'reopened-existing-disposable-db');
    const secondTrust = snapshot(trustDbCycle2, 'reopened-existing-disposable-db');

    assert.equal(firstWorkflow.schema.schemaSha256, secondWorkflow.schema.schemaSha256,
      'workflow schema changed on a second startup against the same disposable DB');
    assert.equal(firstTrust.schema.schemaSha256, secondTrust.schema.schemaSha256,
      'trust schema changed on a second startup against the same disposable DB');
    assert.equal(firstWorkflow.pragmas.foreign_keys, 1);
    assert.equal(firstWorkflow.pragmas.synchronous, 2);
    assert.equal(firstWorkflow.pragmas.busy_timeout, 5000);
    assert.equal(firstWorkflow.pragmas.journal_mode, 'wal');
    assert.equal(firstTrust.pragmas.foreign_keys, 1);
    assert.equal(firstTrust.pragmas.synchronous, 2);
    assert.equal(firstTrust.pragmas.busy_timeout, 0);
    assert.equal(firstTrust.pragmas.journal_mode, 'delete');

    const workflowBytes = fs.readFileSync(WORKFLOW_SOURCE);
    const trustBytes = fs.readFileSync(TRUST_SOURCE);
    return {
      schemaVersion: 1,
      auditKind: 'rc71-disposable-source-db-startup-restart-readback',
      generatedAt: new Date().toISOString(),
      sourceIdentity: {
        workflowStoreSha256: sha256(workflowBytes),
        trustConfigurationSha256: sha256(trustBytes)
      },
      workflow: { first: firstWorkflow, second: secondWorkflow },
      trustLedger: { first: firstTrust, second: secondTrust },
      assertions: {
        workflowSchemaStableAcrossSecondStartup: true,
        trustSchemaStableAcrossSecondStartup: true,
        workflowExpectedConnectionPragmas: true,
        trustExpectedConnectionPragmas: true
      },
      limitations: [
        'Only fresh-create plus repeated initialization of the same newly created disposable database was exercised.',
        'This is not a legacy-schema migration fixture and does not cover partial migration/failure injection.',
        'No production or configured user database path was opened; all temp DBs were removed.',
        'No cross-database snapshot/atomicity, crash durability, independent custody, external checkpoint, host deployment, or worker inventory is established.'
      ]
    };
  } finally {
    try { workflowStore?.db?.close(); } catch {}
    try { workflowCycle2?.db?.close(); } catch {}
    try { trustDb?.close(); } catch {}
    try { trustDbCycle2?.close(); } catch {}
    if (previousEnv.WORKFLOW_DATA_DIR === undefined) delete process.env.WORKFLOW_DATA_DIR;
    else process.env.WORKFLOW_DATA_DIR = previousEnv.WORKFLOW_DATA_DIR;
    if (previousEnv.WORKFLOW_DB === undefined) delete process.env.WORKFLOW_DB;
    else process.env.WORKFLOW_DB = previousEnv.WORKFLOW_DB;
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const result = await capture();
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const outputIndex = argv.indexOf('--output');
  if (outputIndex >= 0) {
    const requested = argv[outputIndex + 1];
    if (!requested) throw new Error('--output requires a file path');
    const output = path.resolve(requested);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Wrote ${path.relative(ROOT, output)}\n`);
  } else process.stdout.write(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
