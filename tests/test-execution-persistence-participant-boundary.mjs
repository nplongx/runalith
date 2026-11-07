import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createWorkflowStatePort } from '../src/runtime/workflow-state-port.js';
import { ExecutionPersistenceStore } from '../src/runtime/execution-persistence-store.js';
import {
  EXECUTION_PERSISTENCE_PARTICIPANT_METHODS,
  createExecutionPersistenceParticipant
} from '../src/runtime/execution-persistence-participant.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-execution-participant-'));
fs.chmodSync(isolatedDataDir, 0o700);
process.env.WORKFLOW_DB = path.join(isolatedDataDir, 'global-workflow.db');
const { WorkflowStore: WorkflowStoreCore } = await import('../src/runtime/job-store.js');

test('Execution persistence participant v1 is a narrow, immutable, same-connection read contract', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const hostStore = new WorkflowStoreCore(database);
    const executionPersistenceStore = new ExecutionPersistenceStore(database);
    const workflowStatePort = createWorkflowStatePort(hostStore, { executionPersistenceStore });
    const participant = createExecutionPersistenceParticipant(executionPersistenceStore, database);
    hostStore.attachExecutionPersistenceParticipant(participant);

    assert.equal(participant.kind, 'execution-persistence-participant');
    assert.equal(participant.version, 1);
    assert.equal(Object.isFrozen(participant), true);
    assert.deepEqual(Object.keys(participant), ['kind', 'version', ...EXECUTION_PERSISTENCE_PARTICIPANT_METHODS]);
    assert.equal(Object.hasOwn(participant, 'db'), false);
    assert.equal(participant.transaction, undefined);
    assert.equal(participant.getTask, undefined);
    assert.equal(participant.recordEvent, undefined);
    assert.equal(participant.hasProviderRunLedger(), true);
    assert.equal(participant.hasProviderDispatchIntentLedger(), true);
    assert.deepEqual(participant.listProviderRunsForJob('job-1'), []);
    assert.deepEqual(participant.getDispatchLedgerForLease('lease-1'), { providerRuns: [], dispatchIntents: [] });
    assert.equal(participant.hasUnresolvedProviderDispatchForJob('job-1'), false);
    assert.equal(participant.hasUnresolvedProviderRunForJob('job-1'), false);
    assert.equal(participant.getProviderRun('run-1'), null);
    assert.equal(executionPersistenceStore.hasProviderRunLedger(), true,
      'ExecutionPersistenceStore constructor must initialize its owned schema');
    assert.deepEqual(participant.listProviderDispatchIntentsForProviderRun('run-1'), []);
    assert.deepEqual(participant.listProviderDispatchIntentsForDispatchKey('dispatch-1'), []);
    assert.equal(executionPersistenceStore.assertSharedConnection(database), true);
    const otherDatabase = new DatabaseSync(':memory:');
    try {
      assert.throws(() => executionPersistenceStore.assertSharedConnection(otherDatabase), /must share.*SQLite connection/);
      assert.throws(() => createExecutionPersistenceParticipant(executionPersistenceStore, otherDatabase), /must share.*SQLite connection/);
    } finally { otherDatabase.close(); }
    assert.equal(Object.hasOwn(executionPersistenceStore, 'db'), false);
    assert.equal(executionPersistenceStore.transaction, undefined);

    const incompleteStore = { version: 1, assertSharedConnection() {}, hasProviderRunLedger() {} };
    assert.throws(() => createExecutionPersistenceParticipant(incompleteStore, database), /must provide hasProviderDispatchIntentLedger\(\)/);

    const coreStore = new WorkflowStoreCore(database);
    const invalidWithDb = {
      kind: 'execution-persistence-participant', version: 1, db: database,
      ...Object.fromEntries(EXECUTION_PERSISTENCE_PARTICIPANT_METHODS.map(method => [method, () => null]))
    };
    assert.throws(() => coreStore.attachExecutionPersistenceParticipant(invalidWithDb), /without a DB handle/);
    assert.throws(() => coreStore.attachExecutionPersistenceParticipant({
      kind: 'execution-persistence-participant', version: 1, hasProviderRunLedger() {}
    }), /must provide hasProviderDispatchIntentLedger\(\)/);
    coreStore.attachExecutionPersistenceParticipant(participant);
    assert.throws(() => coreStore.attachExecutionPersistenceParticipant(participant), /already attached/);
  } finally {
    database.close();
  }
});

test('WorkflowStore core no longer issues SQL against Execution provider ledgers', () => {
  const source = fs.readFileSync(path.join(root, 'src/runtime/job-store.js'), 'utf8');
  assert.doesNotMatch(source, /(?:FROM|JOIN|UPDATE|INTO)\s+(?:provider_runs|provider_dispatch_intents)\b/i);
  assert.match(source, /#executionPersistenceCall\('getDispatchLedgerForLease'/);
  assert.match(source, /#executionPersistenceCall\('listProviderDispatchIntentsForProviderRun'/);
  assert.match(source, /#executionPersistenceCall\('listProviderDispatchIntentsForDispatchKey'/);
  assert.doesNotMatch(source, /import .*workflow-state-port/u,
    'WorkflowStore core must not construct or import its own state port');

  const composition = fs.readFileSync(path.join(root, 'src/runtime/runalith-runtime-composition.js'), 'utf8');
  assert.match(composition, /new ExecutionPersistenceStore\(this\.db\)/);
  assert.match(composition, /createWorkflowStatePort\(this, \{ executionPersistenceStore \}\)/);
  assert.match(composition, /createExecutionPersistenceParticipant\(executionPersistenceStore, this\.db\)/);
  assert.match(composition, /attachExecutionPersistenceParticipant/);
  const executionStoreSource = fs.readFileSync(path.join(root, 'src/runtime/execution-persistence-store.js'), 'utf8');
  assert.match(executionStoreSource, /CREATE TABLE IF NOT EXISTS provider_runs/);
  assert.match(executionStoreSource, /CREATE TABLE IF NOT EXISTS provider_dispatch_intents/);
  assert.match(executionStoreSource, /recordProviderDispatchOutcome\(/,
    'ExecutionPersistenceStore must own provider-only dispatch outcome writes');
  assert.match(executionStoreSource, /reserveProviderDispatchIntent\(/,
    'ExecutionPersistenceStore must own provider-only dispatch intent reservation');
  assert.match(executionStoreSource, /bindReconciledProviderRun\(/,
    'ExecutionPersistenceStore must own reconciled provider-run binding');
  assert.match(executionStoreSource, /releaseProviderDispatchSendClaim\(/,
    'ExecutionPersistenceStore must own provider-only send-claim release');
  assert.match(executionStoreSource, /persistProviderRun\(/,
    'ExecutionPersistenceStore must own provider-run persistence');
  assert.match(executionStoreSource, /bindProviderDispatchRun\(/,
    'ExecutionPersistenceStore must own atomic provider-ledger run binding');
  const workflowPortSource = fs.readFileSync(path.join(root, 'src/runtime/workflow-state-port.js'), 'utf8');
  assert.match(workflowPortSource, /return this\.#executionPersistenceStore\.reserveProviderDispatchIntent\(/);
  assert.match(workflowPortSource, /return this\.#executionPersistenceStore\.recordProviderDispatchOutcome\(/);
  assert.match(workflowPortSource, /return this\.#executionPersistenceStore\.bindReconciledProviderRun\(/);
  assert.match(workflowPortSource, /return this\.#executionPersistenceStore\.releaseProviderDispatchSendClaim\(/);
  assert.match(workflowPortSource, /return this\.#executionPersistenceStore\.persistProviderRun\(/);
  assert.match(workflowPortSource, /return this\.#executionPersistenceStore\.bindProviderDispatchRun\(/);
  assert.doesNotMatch(workflowPortSource,
    /CREATE TABLE IF NOT EXISTS provider_runs|CREATE TABLE IF NOT EXISTS provider_dispatch_intents/,
    'WorkflowStatePort must not own Execution provider ledger schema');
  const outcomeStart = workflowPortSource.indexOf('  recordProviderDispatchOutcome(');
  const outcomeEnd = workflowPortSource.indexOf('  claimProviderDispatchForSend(', outcomeStart);
  assert.ok(outcomeStart >= 0 && outcomeEnd > outcomeStart);
  assert.doesNotMatch(workflowPortSource.slice(outcomeStart, outcomeEnd), /UPDATE provider_dispatch_intents/,
    'provider-only dispatch outcome and reconciliation writes must live in ExecutionPersistenceStore');
});
