import crypto from 'node:crypto';
import { getWorkflowDefinition } from './definitions/index.js';
import { ProductionTaskId, productionTaskSpec, productionChildTaskSpecs } from './catalog/production.js';
import { engineeringTaskSpec, engineeringTaskSpecs } from './catalog/engineering.js';
import { standardEngineeringTaskSpec, standardEngineeringTaskSpecs } from './catalog/standard-engineering.js';
import { hybridEngineeringTaskSpecs } from './catalog/hybrid-engineering.js';
import { validateWorkflowDefinition } from './schema.js';
import { canonicalJson, validateExecutionPlan } from './plan.js';
import { artifactSchemaForType } from './artifacts.js';
import { getAgentArtifactType, getAgentContract, validateCompiledActionIntent } from './agent-contracts.js';
import { normalizeSuccessContract } from './success-contract.js';
import { composePolicySuccessContract, resolveValidationProfileSnapshot, materializeValidationProfileTasks } from './policy-contract.js';
import { BUILTIN_ROLE_PROFILE_OVERLAY_ROLES, createRoleProfileOverlay } from './role-profiles.js';
import { normalizeWorkspaceWriteContract, workspaceWriteScopeForRole } from './workspace-write-contract.js';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function applyActionIntentBindings(children, bindings) {
  if (!Array.isArray(bindings)) throw new Error('actionIntentBindings must be an array');
  if (bindings.length > 256) throw new Error('actionIntentBindings exceeds the 256-task review limit');
  if (!bindings.length) return children;
  const byTaskId = new Map();
  const taskIdBySourceStepId = new Map();
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).sort().join(',') !== 'actionIntent,role,roleContractId,roleContractVersion,taskId' ||
        typeof binding.taskId !== 'string' || !binding.taskId || byTaskId.has(binding.taskId)) {
      throw new Error('actionIntentBindings must contain unique, exact task/role-contract records');
    }
    const child = children.find(item => item.id === binding.taskId);
    if (!child || child.role !== binding.role || child.execution?.deterministic === true ||
        child.execution?.custom_role_id || !binding.actionIntent || typeof binding.actionIntent !== 'object') {
      throw new Error(`action-intent binding targets an unsupported, unknown, deterministic, or custom role task: ${binding.taskId}`);
    }
    const contract = getAgentContract(child.role);
    if (binding.roleContractId !== contract.id || binding.roleContractVersion !== contract.version) {
      throw new Error(`action-intent binding role contract is stale for task ${binding.taskId}`);
    }
    validateCompiledActionIntent(child.role, binding.actionIntent, child.id);
    if (binding.actionIntent.role_contract_id !== binding.roleContractId ||
        binding.actionIntent.role_contract_version !== binding.roleContractVersion) {
      throw new Error(`action-intent binding and embedded role contract disagree for task ${binding.taskId}`);
    }
    if (taskIdBySourceStepId.has(binding.actionIntent.source_step_id)) {
      throw new Error(`action-intent source step is mapped more than once: ${binding.actionIntent.source_step_id}`);
    }
    taskIdBySourceStepId.set(binding.actionIntent.source_step_id, binding.taskId);
    byTaskId.set(binding.taskId, binding);
  }
  const childrenById = new Map(children.map(child => [child.id, child]));
  const ancestorsOf = taskId => {
    const ancestors = new Set();
    const pending = [...(childrenById.get(taskId)?.dependencies || [])];
    while (pending.length) {
      const ancestorId = pending.pop();
      if (ancestors.has(ancestorId)) continue;
      const ancestor = childrenById.get(ancestorId);
      if (!ancestor) throw new Error(`action-intent task ${taskId} depends on unknown plan task ${ancestorId}`);
      ancestors.add(ancestorId);
      pending.push(...(ancestor.dependencies || []));
    }
    return ancestors;
  };
  for (const [taskId, binding] of byTaskId) {
    const intent = binding.actionIntent;
    const ancestry = ancestorsOf(taskId);
    for (const dependencyStepId of intent.dependency_step_ids) {
      const dependencyTaskId = taskIdBySourceStepId.get(dependencyStepId);
      if (!dependencyTaskId || !ancestry.has(dependencyTaskId)) {
        throw new Error(`action-intent dependency ${dependencyStepId} is not preserved as an ancestor of task ${taskId}`);
      }
    }
    for (const input of intent.task_input_bindings) {
      const source = input.source;
      const schema = artifactSchemaForType(input.input_type);
      if (source.schema_version !== schema.schema_version) {
        throw new Error(`action-intent input ${input.input_type} uses a stale artifact schema version for task ${taskId}`);
      }
      if (source.kind === 'evidence') {
        if (source.reference !== source.artifact_id && source.reference !== `artifact://${source.artifact_id}`) {
          throw new Error(`action-intent evidence reference does not match its pinned artifact identity for task ${taskId}`);
        }
        const producerContract = getAgentContract(source.producer_role);
        if (producerContract.id == null || !producerContract.outputs.includes(input.input_type)) {
          throw new Error(`action-intent evidence producer role does not declare ${input.input_type} output for task ${taskId}`);
        }
      } else {
        const sourceTaskId = taskIdBySourceStepId.get(source.source_step_id);
        const sourceTask = childrenById.get(sourceTaskId);
        const sourceContract = sourceTask ? getAgentContract(sourceTask.role) : null;
        const outputType = sourceTask ? (sourceTask.execution?.output_artifact_type || getAgentArtifactType(sourceTask.role)) : null;
        if (!sourceTask || sourceTaskId !== source.task_id || !ancestry.has(sourceTaskId) ||
            sourceTask.role !== source.role || sourceTask.capability !== source.capability ||
            sourceContract?.id !== source.role_contract_id || sourceContract?.version !== source.role_contract_version ||
            outputType !== input.input_type || !sourceContract.outputs.includes(input.input_type)) {
          throw new Error(`action-intent ancestor output ${source.source_step_id} is not a contract-matching ancestor of task ${taskId}`);
        }
      }
    }
  }
  return children.map(child => {
    const binding = byTaskId.get(child.id);
    return binding ? { ...child, execution: { ...(child.execution || {}), action_intent: binding.actionIntent } } : child;
  });
}

function defaultBatchExecutionPolicy(children, { requiresWorkspaceValidation = false } = {}) {
  const deterministic = children.filter(task => task.execution?.deterministic === true && task.execution?.executor === 'ExecutionManager');
  const validationIds = children.filter(task => task.execution?.batch_validation_task === true).map(task => task.id);
  if (requiresWorkspaceValidation && validationIds.length === 0) throw new Error('code-writing plans require exact deterministic batch validation task contracts');
  if (deterministic.length) return {
    schema_version: 1, mode: 'required', scope: 'deterministic-local', route: 'batch-required', grouping: 'ready-compatible',
    evidence: 'durable-batch-and-execution-ledger', workspace_fingerprint_required: validationIds.length > 0,
    validation_task_ids: validationIds, exemption_reason: null
  };
  return {
    schema_version: 1, mode: 'exempt', scope: 'deterministic-local', route: 'not-applicable', grouping: 'not-applicable',
    evidence: 'not-applicable', workspace_fingerprint_required: false, validation_task_ids: [],
    exemption_reason: 'This immutable plan has no deterministic local execution tasks and does not authorize workspace.write.'
  };
}

export function compileWorkflowPlan(job, { workspace = process.env.WORKFLOW_WORKSPACE, customWorkflow = null, successContract = null, policyPacks = [], roleProfiles = [], requiredOperations = [], workspaceWriteScopes = [], workflowVersion = null, batchExecutionPolicy = undefined, validationProfileSelector = null, actionIntentBindings = [] } = {}) {
  if (!job?.job_id) throw new Error('job is required to compile execution plan');
  // null is reserved for existing schema-v1 plans so runtime revalidation never rewrites their hashes.
  const preserveLegacyPlan = batchExecutionPolicy === null;
  if (!Array.isArray(policyPacks)) throw new Error('policyPacks must be an array');
  if (!Array.isArray(roleProfiles)) throw new Error('roleProfiles must be an array');
  if (!Array.isArray(actionIntentBindings)) throw new Error('actionIntentBindings must be an array');
  const pinnedSuccessContract = normalizeSuccessContract(successContract || {}, job.title || job.job_id);
  if (customWorkflow) {
    if (actionIntentBindings.length) throw new Error('typed AGG action-intent bindings are not supported for custom-workflow plans');
    if (validationProfileSelector != null) throw new Error('validation profiles are supported only for built-in standard-engineering v3+ plans');
    if ((requiredOperations || []).length || (workspaceWriteScopes || []).length) {
      throw new Error('custom workflows do not support workspace.write; use a supported built-in standard-engineering v3 plan with explicit role scopes');
    }
    if (roleProfiles.length) throw new Error('built-in role profile overlays cannot be combined with a custom workflow');
    const { workflow, tasks, plan: approvedPreview } = customWorkflow;
    if (!workflow?.workflow_id || !Number.isInteger(workflow.version) || !Array.isArray(tasks) || tasks.length !== workflow.tasks.length) {
      throw new Error('approved custom workflow execution spec is incomplete');
    }
    const children = tasks.map((task, index) => ({
      id: task.id,
      role: `custom-task-${index + 1}`,
      capability: task.role.allowed_capabilities[0] || null,
      dependencies: [...task.depends_on],
      execution: {
        deterministic: false,
        custom_role_id: task.role_id,
        custom_role_version: task.role_version,
        custom_role_name: task.role.name,
        custom_role_description: task.role.description,
        custom_role_system_prompt: task.role.system_prompt,
        custom_role_skills: task.role.skills || [],
        custom_role_capabilities: task.role.allowed_capabilities,
        custom_role_permissions: task.role.permissions,
        custom_role_allowed_tools: task.role.allowed_tools,
        input_contract: task.input_contract,
        output_artifact_type: task.output_artifact_type
      }
    }));
    const policyComposition = policyPacks.length ? composePolicySuccessContract(pinnedSuccessContract, policyPacks, {
      workflowId: `custom-${workflow.workflow_id}`,
      children
    }) : null;
    const pinnedBatchExecutionPolicy = preserveLegacyPlan ? null :
      (batchExecutionPolicy === undefined ? defaultBatchExecutionPolicy(children) : batchExecutionPolicy);
    const plan = {
      schema_version: preserveLegacyPlan ? 1 : 2,
      ...(preserveLegacyPlan ? {} : { batch_execution_policy: pinnedBatchExecutionPolicy }),
      custom_workflow: true,
      custom_workflow_plan_id: customWorkflow.plan_id,
      custom_workflow_plan_hash: customWorkflow.plan_hash,
      custom_workflow_approved_at: customWorkflow.approved_at,
      workflow_id: `custom-${workflow.workflow_id}`,
      workflow_version: workflow.version,
      job_id: job.job_id,
      success_contract: policyComposition?.success_contract || pinnedSuccessContract,
      ...(policyComposition ? { base_success_contract: policyComposition.base_success_contract, policy_packs: policyComposition.policy_packs } : {}),
      phases: ['PROPOSED', 'APPROVED', 'SPAWN_CTO', 'ASSIGN_CHILDREN', 'RUN_CHILDREN', 'SYNTHESIZE', 'TERMINALIZE', 'COMPLETED', 'FAILED'],
      required_children: children.map(item => item.role),
      children,
      synthesis: {
        id: `custom-${workflow.workflow_id}-synthesis`,
        role: 'cto',
        capability: 'synthesis.approve',
        dependencies: children.map(item => item.id),
        execution: { deterministic: false, custom_workflow_synthesis: true, output_artifact_type: 'cto-decision' }
      }
    };
    validateExecutionPlan(plan);
    const planJson = canonicalJson(plan);
    return Object.freeze({ ...plan, plan_hash: hash(planJson) });
  }
  const latestDefinition = getWorkflowDefinition(job);
  if (!latestDefinition) throw new Error('unsupported workflow for execution plan: ' + (job.title || job.job_id));
  const supportedLegacyVersion = latestDefinition.id === 'standard-engineering' && latestDefinition.version === 3 && workflowVersion === 2;
  if (workflowVersion != null && (!Number.isSafeInteger(workflowVersion) || workflowVersion < 1 || workflowVersion > latestDefinition.version ||
      (workflowVersion !== latestDefinition.version && !supportedLegacyVersion))) {
    throw new Error(`unsupported pinned workflow version ${workflowVersion} for ${latestDefinition.id}@${latestDefinition.version}`);
  }
  // Revalidation must compile against the version pinned by an existing plan,
  // not silently upgrade it to today's definition. Current historical versions
  // share the same task graph; version-specific contracts are gated below.
  const definition = workflowVersion == null || workflowVersion === latestDefinition.version
    ? latestDefinition : Object.freeze({ ...latestDefinition, version: workflowVersion });
  validateWorkflowDefinition(definition);
  const isProduction = definition.id === 'production';
  const isStandardEngineering = definition.id === 'standard-engineering';
  const isHybridEngineering = definition.id === 'hybrid-engineering';
  const workspaceWriteContract = normalizeWorkspaceWriteContract({
    workflowId: definition.id,
    workflowVersion: definition.version,
    workspace,
    requiredOperations,
    scopes: workspaceWriteScopes,
    customWorkflow: false
  });
  const validationProfileSnapshot = validationProfileSelector == null ? null : resolveValidationProfileSnapshot(validationProfileSelector);
  if (validationProfileSnapshot && (!isStandardEngineering || definition.version < 3 || !workspaceWriteContract)) {
    throw new Error('validation profiles require an explicit workspace.write contract on standard-engineering v3+');
  }
  if (validationProfileSnapshot && preserveLegacyPlan) {
    throw new Error('validation profiles cannot be added to a legacy schema-v1 immutable plan');
  }
  const validationProfileTasks = validationProfileSnapshot
    ? materializeValidationProfileTasks(validationProfileSnapshot, workspace)
    : null;
  if (roleProfiles.length && !isStandardEngineering && !isHybridEngineering) {
    throw new Error('role profile overlays are currently supported only for standard-engineering and hybrid-engineering workflows');
  }
  const profilesByRole = new Map();
  for (const binding of roleProfiles) {
    if (!binding || !BUILTIN_ROLE_PROFILE_OVERLAY_ROLES.includes(binding.role) || !binding.profile) {
      throw new Error('roleProfiles contains an unsupported built-in role or missing profile snapshot');
    }
    if (profilesByRole.has(binding.role)) throw new Error(`duplicate role profile overlay for built-in role: ${binding.role}`);
    profilesByRole.set(binding.role, binding);
  }
  const baseChildren = isProduction
    ? productionChildTaskSpecs(workspace).map(spec => ({ id: spec.id, role: spec.role, execution: spec.execution, capability: null, dependencies: [] }))
    : isHybridEngineering ? hybridEngineeringTaskSpecs(workspace)
      : isStandardEngineering ? standardEngineeringTaskSpecs(workspace, {
        includeBatchValidation: Boolean(workspaceWriteContract && !preserveLegacyPlan && !validationProfileSnapshot),
        validationTasks: validationProfileTasks
      }) : engineeringTaskSpecs(workspace);
  let children = baseChildren.map(spec => {
    const binding = profilesByRole.get(spec.role);
    let execution = spec.execution;
    if (workspaceWriteContract) {
      const roleScope = workspaceWriteScopeForRole(workspaceWriteContract, spec.role);
      if (roleScope) {
        execution = {
          ...execution,
          execution_mode: 'host-conversation-scoped-workspace-write',
          workspace_write_contract: {
            version: workspaceWriteContract.version,
            operation: 'workspace.write',
            mode: workspaceWriteContract.mode,
            role: spec.role,
            paths: roleScope.paths,
            max_file_bytes: workspaceWriteContract.max_file_bytes,
            precondition: workspaceWriteContract.precondition,
            recovery: workspaceWriteContract.recovery
          }
        };
      }
    }
    if (!binding) return execution === spec.execution ? spec : { ...spec, execution };
    if (execution?.deterministic) throw new Error(`role profile overlay cannot bind deterministic task: ${spec.id}`);
    const overlay = createRoleProfileOverlay(spec.role, binding.profile, binding.profile_hash);
    return { ...spec, execution: { ...execution, role_profile_overlay: overlay } };
  });
  for (const role of profilesByRole.keys()) {
    if (!children.some(child => child.role === role)) throw new Error(`built-in role profile binding does not map to a task in this workflow: ${role}`);
  }
  children = applyActionIntentBindings(children, actionIntentBindings);
  const synthesis = isProduction
    ? productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace })
    : isHybridEngineering
      ? { ...standardEngineeringTaskSpec(definition.synthesisTask, { workspace }), dependencies: children.map(item => item.id) }
      : isStandardEngineering ? standardEngineeringTaskSpec(definition.synthesisTask, { workspace }) : engineeringTaskSpec(definition.synthesisTask, { workspace });
  const pinnedBatchExecutionPolicy = preserveLegacyPlan ? null :
    (batchExecutionPolicy === undefined
      ? defaultBatchExecutionPolicy(children, { requiresWorkspaceValidation: Boolean(workspaceWriteContract) })
      : batchExecutionPolicy);
  const policyComposition = policyPacks.length ? composePolicySuccessContract(pinnedSuccessContract, policyPacks, {
    workflowId: definition.id,
    children
  }) : null;
  const plan = {
    schema_version: preserveLegacyPlan ? 1 : 2,
    ...(preserveLegacyPlan ? {} : { batch_execution_policy: pinnedBatchExecutionPolicy }),
    workflow_id: definition.id,
    workflow_version: definition.version,
    job_id: job.job_id,
    success_contract: policyComposition?.success_contract || pinnedSuccessContract,
    ...(validationProfileSnapshot ? { validation_profile: validationProfileSnapshot } : {}),
    ...(policyComposition ? { base_success_contract: policyComposition.base_success_contract, policy_packs: policyComposition.policy_packs } : {}),
    phases: [...definition.phases],
    required_children: children.map(item => item.id),
    children,
    ...(workspaceWriteContract ? {
      required_operations: [...workspaceWriteContract.required_operations],
      workspace_write_scopes: workspaceWriteContract.scopes,
      workspace_write_contract_version: workspaceWriteContract.version
    } : {}),
    synthesis: {
      id: synthesis.id,
      role: synthesis.role,
      capability: synthesis.capability || null,
      dependencies: synthesis.dependencies || [],
      execution: synthesis.execution
    }
  };
  validateExecutionPlan(plan);
  const planJson = canonicalJson(plan);
  return Object.freeze({ ...plan, plan_hash: hash(planJson) });
}
