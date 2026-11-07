// Shared success predicates are part of the Execution evidence contract.
// Keep them independent from process supervision and Workflow persistence.
export function isVerifiedSuccessfulLocalExecution(result, expectedTaskId) {
  return Boolean(typeof expectedTaskId === 'string' && expectedTaskId.length > 0 &&
    result && typeof result === 'object' && !Array.isArray(result) &&
    result.task_id === expectedTaskId &&
    result.status === 'completed' && result.execution_status === 'completed' &&
    result.execution_exit_code === 0 && (result.exitCode === undefined || result.exitCode === 0) &&
    typeof result.execution_session_id === 'string' && result.execution_session_id.length > 0 &&
    Number.isSafeInteger(result.execution_attempt) && result.execution_attempt > 0 &&
    (result.timedOut === undefined || result.timedOut === false) &&
    (result.outputLimited === undefined || result.outputLimited === false));
}

export function isSuccessfulLocalExecutionSummary(result, expectedTaskId) {
  return Boolean(typeof expectedTaskId === 'string' && expectedTaskId.length > 0 &&
    result && typeof result === 'object' && !Array.isArray(result) &&
    result.executed_locally === true && result.execution_status === 'completed' && result.exit_code === 0 &&
    result.returned_task_id === expectedTaskId &&
    typeof result.execution_session_id === 'string' && result.execution_session_id.length > 0 &&
    result.task && typeof result.task === 'object' && result.task.task_id === expectedTaskId && result.task.status === 'completed' &&
    result.task.execution_status === 'completed' && result.task.execution_exit_code === 0 &&
    result.task.execution_session_id === result.execution_session_id &&
    Number.isSafeInteger(result.task.execution_attempt) && result.task.execution_attempt > 0);
}
