import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterFiles = [
  'server.js',
  'src/runtime/distributed-scheduler.js',
  'src/runtime/github-actions-provider.js',
  'src/runtime/m11-runner-provider.js',
  'src/runtime/execution-manager.js',
  'src/runtime/recovery-manager.js',
  'src/runtime/langgraph-control-loop.js',
  'src/runtime/langgraph-orchestrator.js',
  'src/runtime/m12-native-specialist-bridge.js'
];

for (const relativePath of adapterFiles) {
  const adapterPath = path.join(root, relativePath);
  // The distributable MCPB deliberately excludes the legacy cloud/HTTP adapter.
  // Validate it in the source tree when present; do not make archive validation
  // require a file that the package policy intentionally omits.
  if (relativePath === 'server.js' && !fs.existsSync(adapterPath)) continue;
  const source = fs.readFileSync(adapterPath, 'utf8');
  if (relativePath === 'server.js') {
    assert.equal((source.match(/workflowStore\.db\b/g) || []).length, 1,
      'host may inject the shared DB connection only into the provider-admission owner');
    assert.match(source, /new ProviderAdmissionController\(workflowStore\.db, \{ workflowStatePort: workflowState \}\)/);
    assert.doesNotMatch(source.replace(/new ProviderAdmissionController\(workflowStore\.db, \{ workflowStatePort: workflowState \}\)/, ''),
      /workflowStore\.db\b/, 'no other host adapter may reach through WorkflowStore.db');
  } else {
    assert.doesNotMatch(source, /(?:this\.)?store\?*\.db\b|this\.store\.db\b|workflowStore\.db\b/,
      `${relativePath} must use WorkflowStatePort instead of reaching through WorkflowStore.db`);
  }
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:OR\s+\w+\s+)?(?:\*|[\w`, ]+)\s+FROM\s+(?:task_leases|provider_dispatch_intents|provider_runs|m12_native_specialist_runtime|m12_native_specialist_start_intents)\b/i,
    `${relativePath} must not issue raw SQL against WorkflowStatePort-owned tables`);
}

const providerAdmissionSource = fs.readFileSync(path.join(root, 'src/runtime/provider-admission.js'), 'utf8');
assert.match(providerAdmissionSource, /workflowStatePort/,
  'ProviderAdmissionController must receive a named Workflow state boundary from host composition');
assert.match(providerAdmissionSource, /#db/,
  'ProviderAdmissionController must keep its provider-owned persistence connection private');
assert.doesNotMatch(providerAdmissionSource, /this\.store|workflowStore\.db/,
  'ProviderAdmissionController must not retain a broad WorkflowStore reference');
assert.doesNotMatch(providerAdmissionSource, /this\.store\.getTask|this\.store\.recordEvent\(|FROM\s+tasks\b/i,
  'ProviderAdmissionController must not read or write Workflow-owned task/event state directly');
assert.doesNotMatch(providerAdmissionSource, /(?:FROM|UPDATE|INTO|JOIN)\s+(?:tasks|jobs|events|attempts|results|artifacts|reports|task_leases|provider_runs|provider_dispatch_intents)\b/i,
  'ProviderAdmissionController SQL must be limited to provider-admission-owned tables');
assert.match(providerAdmissionSource, /getLatestChildTaskForRole/,
  'provider orphan reconciliation must use a named Workflow query for child-task resolution');
const hostServer = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.match(hostServer, /new ProviderAdmissionController\(workflowStore\.db, \{ workflowStatePort: workflowState \}\)/,
  'host composition must inject provider-owned DB connection and WorkflowStatePort separately');
assert.match(hostServer, /new ExecutionManager\(null, \{ statePort: workflowState \}\)/,
  'host composition must inject WorkflowStatePort into ExecutionManager');
assert.match(hostServer, /new RecoveryManager\(null, \{[\s\S]*?statePort: workflowState,[\s\S]*?agentSessions: workflowStore\.agentSessions/,
  'host composition must inject WorkflowStatePort and Agent Session API separately into RecoveryManager');
assert.match(hostServer, /new GitHubActionsProvider\(\{ statePort: workflowState \}\)/,
  'host composition must inject WorkflowStatePort into GitHub Actions provider');
assert.match(hostServer, /new M11RunnerProvider\(\{[\s\S]*?statePort: workflowState/,
  'host composition must inject WorkflowStatePort into M11 provider');
const schedulerSource = fs.readFileSync(path.join(root, 'src/runtime/distributed-scheduler.js'), 'utf8');
assert.doesNotMatch(schedulerSource, /this\.store/,
  'DistributedScheduler must not retain a broad WorkflowStore reference');
assert.match(hostServer, /new DistributedScheduler\(\{[\s\S]*?statePort: workflowState,[\s\S]*?provider: workflowWorkerProvider/,
  'host composition must inject WorkflowStatePort into DistributedScheduler');
for (const providerSourcePath of ['src/runtime/github-actions-provider.js', 'src/runtime/m11-runner-provider.js']) {
  const providerSource = fs.readFileSync(path.join(root, providerSourcePath), 'utf8');
  assert.doesNotMatch(providerSource, /this\.store/,
    `${providerSourcePath} must not retain a broad WorkflowStore reference`);
}

const mcpEntrypoint = fs.readFileSync(path.join(root, 'server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js'), 'utf8');
assert.match(mcpEntrypoint, /createWorkflowStatePort\(workflowStore\)/,
  'active MCP entrypoint must compose the WorkflowStatePort');
assert.doesNotMatch(mcpEntrypoint,
  /workflowStore\.db\.prepare\(\s*[`'\"][^`'\"]*\b(?:FROM|INTO|UPDATE|DELETE FROM)\s+(?:jobs|tasks|events|results|artifacts|attempts|approvals|reports|workflow_plans|execution_batches|execution_batch_items|task_leases|provider_runs|provider_dispatch_intents|m12_native_specialist_runtime|m12_native_specialist_start_intents)\b/i,
  'active MCP entrypoint must use WorkflowStatePort for Workflow-owned SQL; specialised stores retain their own table APIs');
assert.match(mcpEntrypoint, /createManualInterventionStore\(workflowStore\)/,
  'manual intervention storage must use its own store API');
assert.match(mcpEntrypoint, /createWorkspaceWriteReceiptStore\(workflowStore\)/,
  'workspace write receipt storage must use its own store API');
assert.match(mcpEntrypoint, /createWorkspaceWriteCapabilityService\(/,
  'workspace-write use case must be composed through its capability service');
const writeCase = mcpEntrypoint.match(/case 'workflow_write_files': \{([\s\S]*?)\n\s*case 'workflow_approve': \{/);
assert.ok(writeCase, 'active MCP entrypoint must retain the workflow_write_files adapter');
assert.match(writeCase[1], /workspaceWriteCapabilityService\.applyWrite\(request\)/,
  'workflow_write_files adapter must delegate to WorkspaceWriteCapabilityService');
assert.doesNotMatch(writeCase[1], /workflowStore|workspaceWriteReceiptStore|secureFilesystemRuntime|replaceFileWithin|recordEvent|compileExecutionPlan/,
  'workflow_write_files MCP adapter must not own authorization, filesystem, receipt or event orchestration');
assert.match(mcpEntrypoint, /createAdaptiveGoalTransactionBoundary\(workflowStore\)/,
  'AGG transaction lifecycle must use named transaction boundary methods');
assert.doesNotMatch(mcpEntrypoint, /const\s+db\s*=\s*workflowStore\.db\s*;/,
  'active MCP composition must not keep an aliased WorkflowStore DB handle for transaction control');
for (const operation of [
  'beginPlanGraphProposalCreate', 'commitPlanGraphProposalCreate', 'rollbackPlanGraphProposalCreate',
  'beginExecutionGraphProposalCreate', 'commitExecutionGraphProposalCreate', 'rollbackExecutionGraphProposalCreate',
  'beginExecutionGraphProposalRead', 'commitExecutionGraphProposalRead', 'rollbackExecutionGraphProposalRead',
  'beginExecutionPlanCandidateCreate', 'commitExecutionPlanCandidateCreate', 'rollbackExecutionPlanCandidateCreate',
  'beginExecutionPlanCandidateRead', 'commitExecutionPlanCandidateRead', 'rollbackExecutionPlanCandidateRead',
  'beginExecutionReadinessPreview', 'commitExecutionReadinessPreview', 'rollbackExecutionReadinessPreview',
  'beginSandboxActionClaim', 'commitSandboxActionClaim', 'rollbackSandboxActionClaim'
]) {
  assert.match(mcpEntrypoint, new RegExp(`adaptiveGoalTransactions\\.${operation}\\(\\)`),
    `active MCP composition must use named AGG transaction method ${operation}`);
}
assert.doesNotMatch(mcpEntrypoint,
  /workflowStore\.db\.(?:prepare\(\s*[`'\"][^`'\"]*\b(?:FROM|INTO|UPDATE|DELETE FROM)\s+(?:workspace_write_receipts|manual_interventions)\b|exec\(\s*`[^`]*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:workspace_write_receipts|manual_interventions)\b)/i,
  'active MCP entrypoint must not implement manual-intervention or workspace receipt schema/queries directly');
assert.match(mcpEntrypoint, /createCase01SnapshotStore\(workflowStore\)/,
  'CASE-01 snapshot reservations and consumption acknowledgements must use their own store API');
assert.doesNotMatch(mcpEntrypoint,
  /workflowStore\.db\.(?:prepare\(\s*[`'\"][^`'\"]*\b(?:FROM|INTO|UPDATE|DELETE FROM)\s+case01_(?:snapshot_reservations|consumption_acks)\b|exec\(\s*`[^`]*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+case01_(?:snapshot_reservations|consumption_acks)\b)/i,
  'active MCP entrypoint must not own CASE-01 snapshot/ack schema or table queries');

const portSource = fs.readFileSync(path.join(root, 'src/runtime/workflow-state-port.js'), 'utf8');
assert.match(portSource, /export const WORKFLOW_STATE_PORT_VERSION = 2/);
assert.match(portSource, /class WorkflowStatePort/);
assert.match(portSource, /#store/);
assert.doesNotMatch(portSource, /transaction\s*\(/,
  'WorkflowStatePort must not expose a generic transaction callback');
assert.match(portSource, /authorizeExecutionSpawn\(/,
  'WorkflowStatePort must expose one atomic Workflow-owned spawn authorization command');
assert.doesNotMatch(portSource, /beginExecutionSpawnAuthorization|commitExecutionSpawnAuthorization|rollbackExecutionSpawnAuthorization/,
  'callers must not control spawn authorization transaction boundaries');
const executionManagerSource = fs.readFileSync(path.join(root, 'src/runtime/execution-manager.js'), 'utf8');
assert.doesNotMatch(executionManagerSource, /this\.store\./,
  'ExecutionManager must use named WorkflowStatePort APIs rather than broad WorkflowStore methods');
assert.match(executionManagerSource, /this\.state\.authorizeExecutionSpawn\(/,
  'ExecutionManager must delegate final spawn authorization to the Workflow-owned atomic command');
assert.doesNotMatch(executionManagerSource,
  /beginExecutionSpawnAuthorization|commitExecutionSpawnAuthorization|rollbackExecutionSpawnAuthorization|BEGIN IMMEDIATE|\bCOMMIT\b|\bROLLBACK\b/,
  'ExecutionManager must not control the spawn authorization transaction boundary');
for (const operation of [
  'getExecutionPlan', 'getCurrentProposal', 'getLatestApproval', 'assertApprovalCurrent', 'compileExecutionPlan',
  'getExecutionBatch', 'listExecutionBatchItems', 'recoverUnstartedExecutionBatchClaims',
  'prepareExecution', 'prepareExecutionForBatchClaim', 'setExecutionPid', 'finishExecution',
  'assertImmutablePlannedExecution', 'authorizeExecutionSpawn'
]) {
  assert.match(portSource, new RegExp(`\\b${operation}\\(`),
    `WorkflowStatePort must expose named Execution operation ${operation}`);
}
const recoverySource = fs.readFileSync(path.join(root, 'src/runtime/recovery-manager.js'), 'utf8');
assert.doesNotMatch(recoverySource, /this\.store\./,
  'RecoveryManager must use WorkflowStatePort and Agent Session API instead of broad WorkflowStore methods');
assert.match(recoverySource, /agentSessions = store\?\.agentSessions/,
  'RecoveryManager must consume the composed Agent Session API');
assert.doesNotMatch(recoverySource, /from ['"]\.\/execution-manager\.js['"]/, 
  'RecoveryManager must not depend on process-supervisor implementation to verify execution evidence');
assert.match(recoverySource, /from ['"]\.\/execution-evidence\.js['"]/);
const langGraphControlLoopSource = fs.readFileSync(path.join(root, 'src/runtime/langgraph-control-loop.js'), 'utf8');
assert.doesNotMatch(langGraphControlLoopSource, /this\.store\./,
  'LangGraphControlLoop must use WorkflowStatePort and WorkflowControlPort rather than broad WorkflowStore methods');
assert.match(langGraphControlLoopSource, /createWorkflowControlPort\(store\)/);
const workflowControlPortSource = fs.readFileSync(path.join(root, 'src/runtime/workflow-control-port.js'), 'utf8');
assert.match(workflowControlPortSource, /WORKFLOW_CONTROL_PORT_VERSION = 1/);
assert.match(workflowControlPortSource, /Object\.freeze\(port\)/);
assert.doesNotMatch(workflowControlPortSource, /\.db\b|transaction\s*\(/,
  'WorkflowControlPort must not expose persistence handles or generic transactions');
assert.match(fs.readFileSync(path.join(root, 'src/runtime/langgraph-orchestrator.js'), 'utf8'),
  /workflowControlPort = null/);
for (const operation of [
  'getRecoveryJobSnapshot', 'reconcileRunningTaskForTerminalJob', 'completeTaskByRuntime', 'repairResultEvidence',
  'reconcileFailedTaskByRuntime', 'setProviderWaiting', 'clearProviderWaiting', 'createReport', 'claimDelivery', 'terminalizeJob'
]) {
  assert.match(portSource, new RegExp(`\\b${operation}\\(`),
    `WorkflowStatePort must expose named recovery operation ${operation}`);
}

const workflowStoreSource = fs.readFileSync(path.join(root, 'src/runtime/job-store.js'), 'utf8');
assert.doesNotMatch(workflowStoreSource, /from ['"]\.\/adaptive-goal-(?:execution-plan-candidate|reviewer-identity)\.js['"]|from ['"]\.\/adaptive-goal-action-intent-policy\.js['"]|from ['"]\.\/adaptive-goal-(?:execution-graph-proposal|reviewed-task-inputs)\.js['"]/, 
  'WorkflowStore must not import AGG implementation modules; verification enters through an injected port');
assert.match(workflowStoreSource, /setAdaptiveGoalActionIntentBindingsResolver\(/,
  'WorkflowStore must expose a one-time resolver injection boundary for AGG action-intent bindings');
assert.doesNotMatch(workflowStoreSource, /adaptive_goal\.execution_plan_candidate_created|actionIntentBindingsFromCandidate|assertActionIntentEvidenceCurrent/,
  'WorkflowStore must not parse AGG candidate events or own AGG evidence-lineage resolution');
const aggBindingResolver = fs.readFileSync(path.join(root, 'src/runtime/adaptive-goal-action-intent-binding-resolver.js'), 'utf8');
assert.match(aggBindingResolver, /createAdaptiveGoalActionIntentBindingResolver\(/);
assert.match(aggBindingResolver, /requiredFunction\(workflowPort, 'getArtifactStorageRecord'/);
assert.match(aggBindingResolver, /requiredFunction\(workflowPort, 'listArtifactCreatedEvents'/);
assert.match(aggBindingResolver, /requiredFunction\(workflowPort, 'getResult'/);
assert.doesNotMatch(aggBindingResolver, /workflowStore\.db|store\.db|from ['"].*job-store\.js['"]/, 
  'AGG candidate resolver must use the WorkflowStatePort, not WorkflowStore internals');
const compiledAgentContracts = fs.readFileSync(path.join(root, 'src/runtime/workflow/agent-contracts.js'), 'utf8');
assert.doesNotMatch(compiledAgentContracts, /from ['"]\.\.\/adaptive-goal-action-intent-policy\.js['"]|from ['"]\.\.\/adaptive-goal-execution-plan-candidate\.js['"]/, 
  'Workflow agent contract validation must not import AGG semantic implementation');
assert.match(compiledAgentContracts, /configureCompiledActionIntentSemanticVerifier\(/,
  'Workflow action-intent validator must accept AGG semantic policy through composition');
assert.match(mcpEntrypoint, /setAdaptiveGoalActionIntentBindingsResolver\(/,
  'active composition must inject the AGG candidate/evidence resolver');
assert.match(mcpEntrypoint, /configureCompiledActionIntentSemanticVerifier\(/,
  'active composition must inject AGG semantic policy into Workflow contract validation');

const workspaceWriteService = fs.readFileSync(path.join(root, 'src/runtime/workspace-write-capability-service.js'), 'utf8');
assert.match(workspaceWriteService, /export class WorkspaceWriteCapabilityService/);
assert.match(workspaceWriteService, /workflowPort/);
assert.match(workspaceWriteService, /workspacePort/);
assert.match(workspaceWriteService, /receiptStore/);
assert.doesNotMatch(workspaceWriteService, /workflowStore\.db|server\/index|from ['"](?:\.\.\/)+server\//i,
  'workspace-write application service must not depend on WorkflowStore internals or MCP transport');

console.log('workflow-state-port consumer boundary PASS');
