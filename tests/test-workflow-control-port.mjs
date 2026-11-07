import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_CONTROL_PORT_METHODS,
  WORKFLOW_CONTROL_PORT_VERSION,
  createWorkflowControlPort
} from '../src/runtime/workflow-control-port.js';

test('WorkflowControlPort v1 exposes only frozen named lifecycle operations', () => {
  const calls = [];
  const implementation = Object.fromEntries(WORKFLOW_CONTROL_PORT_METHODS.map(method => [method, function (...args) {
    calls.push({ method, receiver: this, args });
    return { method, args };
  }]));
  implementation.db = { prepare() { throw new Error('must not be exposed'); } };
  implementation.transaction = () => { throw new Error('must not be exposed'); };
  const port = createWorkflowControlPort(implementation);

  assert.equal(WORKFLOW_CONTROL_PORT_VERSION, 1);
  assert.equal(port.version, 1);
  assert.equal(Object.isFrozen(port), true);
  assert.deepEqual(Object.keys(port), ['version', ...WORKFLOW_CONTROL_PORT_METHODS]);
  assert.equal(Object.hasOwn(port, 'db'), false);
  assert.equal(port.transaction, undefined);
  assert.equal(port.unknownLifecycleMethod, undefined);
  assert.equal(port.getJob('job-1').method, 'getJob');
  assert.equal(calls[0].receiver, implementation, 'methods must remain bound to the Workflow owner');
  assert.deepEqual(calls[0].args, ['job-1']);
  assert.throws(() => createWorkflowControlPort(null), /requires a Workflow implementation/);
  assert.throws(() => createWorkflowControlPort({}), /must provide getJob\(\)/);
});
