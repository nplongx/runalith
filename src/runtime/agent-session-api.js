/** Versioned in-process contract between the Agent Session owner and its host. */
export const AGENT_SESSION_API_VERSION = 1;
export const AGENT_SESSION_LIFECYCLE_PARTICIPANT_VERSION = 1;

export const AGENT_SESSION_API_METHODS = Object.freeze([
  'getSession', 'getSessionByOpenClawKey', 'getSessionByTask', 'createAgentSession',
  'updateAgentSession', 'heartbeatAgentSession', 'listAgentSessions',
  'getSessionAccess', 'listSessionAccess', 'grantSessionAccess', 'revokeSessionAccess',
  'hasSessionPermission', 'assertSessionPermission', 'attachAgentSession', 'takeoverAgentSession',
  'enqueueSessionMessage', 'getSessionMessage', 'listSessionMessages', 'claimSessionMessage',
  'claimNextSessionMessage', 'deliverNextSessionMessage', 'assertDurableSuccessfulSessionReceipt',
  'ackSessionMessage', 'markSessionMessageDeliveryUncertain', 'retrySessionMessage',
  'retryExpiredSessionMessages', 'reconcileSessionDelivery', 'recordSessionDeliveryReceipt',
  'recordSessionDeliveryStarted', 'deliverSessionMessage', 'markStaleAgentSessions',
  'markAgentSessionStale', 'listActiveAgentSessionsForJob', 'getSessionTraceForJob'
]);

// These methods let Workflow participate in existing same-connection atomic
// transitions. They are host integration hooks, not public Agent domain API.
export const AGENT_SESSION_LIFECYCLE_METHODS = Object.freeze([
  'lockSession', 'updateRetryAttempt', 'terminateSessionsForTask'
]);

export const AGENT_SESSION_DELIVERY_HOOKS = Object.freeze([
  'ackSessionMessage', 'markSessionMessageDeliveryUncertain', 'retrySessionMessage',
  'recordSessionDeliveryReceipt'
]);

function bindMethods(implementation, methods, label, version) {
  if (!implementation || typeof implementation !== 'object') {
    throw new TypeError(`${label} implementation is required`);
  }
  const api = { version };
  for (const method of methods) {
    if (typeof implementation[method] !== 'function') {
      throw new TypeError(`${label} implementation must provide ${method}()`);
    }
    api[method] = implementation[method].bind(implementation);
  }
  return Object.freeze(api);
}

export function createAgentSessionPort(implementation) {
  return bindMethods(implementation, AGENT_SESSION_API_METHODS, 'Agent Session domain port', AGENT_SESSION_API_VERSION);
}

export function createAgentSessionLifecycleParticipant(implementation) {
  return Object.freeze({
    kind: 'agent-session-lifecycle-participant',
    ...bindMethods(implementation, AGENT_SESSION_LIFECYCLE_METHODS, 'Agent Session lifecycle participant',
      AGENT_SESSION_LIFECYCLE_PARTICIPANT_VERSION)
  });
}

export function createAgentSessionApi(port) {
  if (port?.version !== AGENT_SESSION_API_VERSION) {
    throw new TypeError(`unsupported Agent Session API version: ${String(port?.version)}`);
  }
  return bindMethods(port, AGENT_SESSION_API_METHODS, 'Agent Session port', AGENT_SESSION_API_VERSION);
}
