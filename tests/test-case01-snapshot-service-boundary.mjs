import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servicePath = path.join(root, 'src/runtime/workflow/case01-snapshot-service.js');
const entrypointPath = path.join(root, 'server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js');
const service = fs.readFileSync(servicePath, 'utf8');
const entrypoint = fs.readFileSync(entrypointPath, 'utf8');

assert.match(service, /export class Case01SnapshotService/);
for (const operation of [
  'completeRequirementsTask', 'validateTaskEvidence', 'validateSynthesisEvidence',
  'recordConsumptionAck', 'validateConsumptionAck', 'reconcileSnapshots',
  'readVerifiedWorkspaceSnapshot'
]) {
  assert.match(service, new RegExp(`${operation}\\s*\\(`), `CASE-01 service must own ${operation}`);
}
assert.match(service, /beginConsumptionAckTransaction\(\)[\s\S]*?getArtifact\(/,
  'consumption lineage and authority reads must remain behind the acknowledgement writer reservation');
assert.match(service, /beginSnapshotCleanupTransaction\(\)[\s\S]*?validateCase01DurableSnapshotReferences\(/,
  'snapshot reference validation must run inside the cleanup writer transaction');
assert.doesNotMatch(service, /workflowStore\.db|from ['"](?:\.\.\/)+server\//i,
  'CASE-01 application service must not depend on WorkflowStore internals or MCP transport');

assert.match(entrypoint, /createCase01SnapshotService\(/,
  'active MCP entrypoint must compose CASE-01 through its application service');
assert.doesNotMatch(entrypoint,
  /function (?:recordCase01ConsumptionAck|validateCase01ConsumptionAck|reconcileCase01SnapshotStore|compensateCase01SnapshotIfUnreferenced)\s*\(/,
  'active MCP entrypoint must not own CASE-01 snapshot, acknowledgement or recovery orchestration');
assert.doesNotMatch(entrypoint,
  /createCase01WorkspaceSnapshot\(|readVerifiedCase01WorkspaceSnapshot\(|validateCase01DurableSnapshotReferences\(/,
  'active MCP entrypoint must delegate snapshot filesystem operations to CASE-01 service');

const completion = entrypoint.match(/case 'workflow_complete_task': \{([\s\S]*?)\n\s*case 'execute_batch':/);
assert.ok(completion, 'active MCP task-completion adapter must remain discoverable');
assert.match(completion[1], /case01SnapshotService\.completeRequirementsTask\(/,
  'CASE-01 task completion must delegate snapshot creation and compensation');
assert.doesNotMatch(completion[1], /reserveSnapshot\(|deleteSnapshotReservation\(|createCase01WorkspaceSnapshot\(/,
  'MCP task-completion adapter must not manage CASE-01 reservations or snapshot bytes');

assert.match(entrypoint, /case01SnapshotService\.recordConsumptionAck\(/,
  'MCP synthesis adapter must delegate exact consumer-byte acknowledgement');
assert.match(entrypoint, /case01SnapshotService\.validateConsumptionAck\(/,
  'workflow diagnostics must delegate durable acknowledgement verification');
assert.match(entrypoint, /case01SnapshotService\.reconcileSnapshots\(/,
  'startup and periodic snapshot recovery must delegate to CASE-01 service');

console.log('CASE-01 snapshot application-service boundary PASS');
