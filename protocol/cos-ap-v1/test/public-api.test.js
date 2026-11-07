import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  COS_AP_MESSAGE_TYPES,
  COS_AP_PROTOCOL,
  COS_AP_SCHEMA_NAMES,
  COS_AP_VERSION,
  DurableExecutionResultStatus,
  MAX_EXECUTION_BATCH_ITEMS,
  MAX_EXECUTION_COMMAND_CHARS,
  MAX_EXECUTION_TIMEOUT_MS,
  createEnvelope,
  readSchema,
  schemaPath,
  validateDurableExecutionRequest,
  validateDurableExecutionResult,
  validateEnvelope,
  validateExecutionBatch,
  validateExecutionResult,
  validatePayload
} from '../index.js';

test('the documented package entry point exports the complete v0 public surface', () => {
  assert.equal(COS_AP_PROTOCOL, 'cos-ap');
  assert.equal(COS_AP_VERSION, 1);
  assert.equal(MAX_EXECUTION_BATCH_ITEMS, 32);
  assert.equal(MAX_EXECUTION_COMMAND_CHARS, 32768);
  assert.equal(MAX_EXECUTION_TIMEOUT_MS, 600000);
  assert.ok(Object.isFrozen(COS_AP_MESSAGE_TYPES));
  assert.ok(Object.isFrozen(COS_AP_SCHEMA_NAMES));
  assert.ok(Object.isFrozen(DurableExecutionResultStatus));

  for (const operation of [
    createEnvelope,
    readSchema,
    schemaPath,
    validateDurableExecutionRequest,
    validateDurableExecutionResult,
    validateEnvelope,
    validateExecutionBatch,
    validateExecutionResult,
    validatePayload
  ]) {
    assert.equal(typeof operation, 'function');
  }
});

test('all published JSON Schemas resolve inside this package', () => {
  const names = [
    'child-result',
    'envelope',
    'execution-batch',
    'execution-result',
    'provider-status',
    'synthesis'
  ];
  assert.deepEqual([...COS_AP_SCHEMA_NAMES].sort(), [...names].sort());

  for (const name of names) {
    const schemaFile = schemaPath(name);
    assert.ok(schemaFile.startsWith(new URL('../', import.meta.url).pathname.replace(/\/$/, '')));
    assert.ok(fs.statSync(schemaFile).isFile());
    assert.equal(readSchema(name).$id, `cos-ap/1/${name}`);
  }
});

test('schema lookup rejects names that could escape the package directory', () => {
  assert.throws(() => schemaPath('../../README'), /unsupported COS-AP schema name/);
  assert.throws(() => readSchema('../../README'), /unsupported COS-AP schema name/);
});

test('envelope and batch public contracts reject unsupported wire shapes', () => {
  const envelope = {
    protocol: 'cos-ap',
    version: 1,
    message_id: 'msg_contract',
    message_type: 'execution.batch',
    job_id: 'job_contract',
    task_id: null,
    attempt: 1,
    sender: 'planner',
    recipient: 'executor',
    correlation_id: null,
    created_at: '2026-10-31T00:00:00Z',
    payload: {
      batch_id: 'batch_contract',
      wait: 'all',
      tasks: [{ id: 'item_1', task_id: 'task_1', command: 'node --version' }]
    }
  };

  assert.equal(validateEnvelope(envelope), envelope);
  assert.equal(validatePayload('execution.batch', envelope.payload), envelope.payload);
  assert.throws(() => validateEnvelope({ ...envelope, unsupported: true }), /unsupported field unsupported/);
  assert.throws(() => validateEnvelope({ ...envelope, message_type: 'execution.future' }), /unsupported message_type/);
  assert.equal(validateExecutionBatch(envelope.payload), envelope.payload);
  assert.throws(() => validateExecutionBatch({
    ...envelope.payload,
    tasks: Array.from({ length: MAX_EXECUTION_BATCH_ITEMS + 1 }, (_, index) => ({
      id: `item_${index}`,
      task_id: `task_${index}`,
      command: 'node --version'
    }))
  }), /1\.\.32 items/);
  assert.equal(typeof validateExecutionResult, 'function');
  assert.equal(typeof validateDurableExecutionRequest, 'function');
  assert.equal(typeof validateDurableExecutionResult, 'function');
});

test('execution result validation reconciles every terminal item with its summary', () => {
  const result = {
    batch_id: 'batch_result',
    status: 'completed',
    summary: { total: 1, passed: 1, failed: 0 },
    items: [{
      id: 'item_result',
      task_id: 'task_result',
      command: 'node --version',
      status: 'COMPLETED',
      exit_code: 0,
      execution_session_id: 'session_result',
      stdout: 'v24',
      stderr: '',
      error: null
    }]
  };

  assert.equal(validateExecutionResult(result), result);
  assert.throws(() => validateExecutionResult({
    ...result,
    summary: { total: 1, passed: 0, failed: 1 }
  }), /summary\.passed must equal/);
});

test('durable execution request and result validators enforce identity and success evidence', () => {
  const request = {
    schema_version: 1,
    job_id: 'job_contract',
    task_id: 'task_contract',
    lease_id: 'lease_contract',
    attempt: 1,
    role: 'engineer',
    input_commit: 'a'.repeat(40),
    task_payload_ref: 'sha256:' + 'b'.repeat(64),
    required_evidence: ['artifact:execution-result']
  };
  assert.equal(validateDurableExecutionRequest(request), request);
  assert.throws(() => validateDurableExecutionRequest({ ...request, attempt: 0 }), /attempt must be a safe integer/);

  const result = {
    schema_version: 1,
    job_id: 'job_contract',
    task_id: 'task_contract',
    lease_id: 'lease_contract',
    attempt: 1,
    status: 'SUCCEEDED',
    input_commit: 'a'.repeat(40),
    output_commit: 'c'.repeat(40),
    exit_code: 0,
    provider_run_id: 'provider-run-contract',
    evidence_artifact: 'artifact:execution-result',
    evidence_refs: ['artifact:execution-result'],
    started_at: '2026-10-31T00:00:00Z',
    finished_at: '2026-10-31T00:00:01Z'
  };
  assert.equal(validateDurableExecutionResult(result), result);
  assert.throws(() => validateDurableExecutionResult({ ...result, evidence_refs: [] }), /SUCCEEDED requires evidence_refs/);
  assert.throws(() => validateDurableExecutionResult({ ...result, finished_at: '2026-10-30T23:59:59Z' }), /finished_at must not precede started_at/);
});
