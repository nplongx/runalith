import {
  EXECUTION_PERSISTENCE_READ_METHODS,
  EXECUTION_PERSISTENCE_STORE_VERSION
} from './execution-persistence-store.js';

export const EXECUTION_PERSISTENCE_PARTICIPANT_VERSION = 1;
export const EXECUTION_PERSISTENCE_PARTICIPANT_METHODS = EXECUTION_PERSISTENCE_READ_METHODS;

/**
 * Internal read participant for Workflow transactions that must reconcile
 * Execution-owned provider ledgers on the same SQLite connection.
 * It deliberately exposes neither a database handle nor transaction controls.
 */
export function createExecutionPersistenceParticipant(executionPersistenceStore, database) {
  if (!executionPersistenceStore || typeof executionPersistenceStore !== 'object' || executionPersistenceStore.version !== EXECUTION_PERSISTENCE_STORE_VERSION ||
      typeof executionPersistenceStore.assertSharedConnection !== 'function') {
    throw new TypeError('Execution persistence participant requires ExecutionPersistenceStore v1');
  }
  executionPersistenceStore.assertSharedConnection(database);
  const participant = {
    kind: 'execution-persistence-participant',
    version: EXECUTION_PERSISTENCE_PARTICIPANT_VERSION
  };
  for (const method of EXECUTION_PERSISTENCE_PARTICIPANT_METHODS) {
    if (typeof executionPersistenceStore[method] !== 'function') {
      throw new TypeError(`ExecutionPersistenceStore v1 must provide ${method}()`);
    }
    Object.defineProperty(participant, method, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: executionPersistenceStore[method].bind(executionPersistenceStore)
    });
  }
  return Object.freeze(participant);
}
