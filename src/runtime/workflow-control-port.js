export const WORKFLOW_CONTROL_PORT_VERSION = 1;

export const WORKFLOW_CONTROL_PORT_METHODS = Object.freeze([
  'getJob',
  'getExecutionPlan',
  'getWorkflowRuntimeState',
  'getLatestArtifact',
  'prepareStandardEngineeringRework',
  'hasEvent',
  'getJobTrace',
  'setWorkflowRuntimeState',
  'setProviderWaiting',
  'transitionWorkflowPhase'
]);

/** Narrow Workflow lifecycle commands/queries used by the LangGraph controller. */
export function createWorkflowControlPort(implementation) {
  if (!implementation || typeof implementation !== 'object') {
    throw new TypeError('WorkflowControlPort requires a Workflow implementation');
  }
  const port = { version: WORKFLOW_CONTROL_PORT_VERSION };
  for (const method of WORKFLOW_CONTROL_PORT_METHODS) {
    if (typeof implementation[method] !== 'function') {
      throw new TypeError(`WorkflowControlPort implementation must provide ${method}()`);
    }
    Object.defineProperty(port, method, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: implementation[method].bind(implementation)
    });
  }
  return Object.freeze(port);
}
