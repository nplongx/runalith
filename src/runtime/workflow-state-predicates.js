function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name));
}

function columnExists(database, table, column) {
  return database.prepare(`PRAGMA table_info("${table}")`).all().some(item => item.name === column);
}

/** Pure SQL predicate shared by WorkflowStore and WorkflowStatePort. */
export function findUnresolvedProviderOutcome(database, jobId, taskId = null) {
  const hasIntents = tableExists(database, 'provider_dispatch_intents');
  const hasRuns = tableExists(database, 'provider_runs');
  const runHasJobId = hasRuns && columnExists(database, 'provider_runs', 'job_id');
  const runHasTaskId = hasRuns && columnExists(database, 'provider_runs', 'task_id');
  const hasLeases = tableExists(database, 'task_leases');
  const hasNativeRuntimes = tableExists(database, 'm12_native_specialist_runtime');
  const hasNativeStartIntents = tableExists(database, 'm12_native_specialist_start_intents');
  const taskClause = taskId === null ? '' : ' AND task_id=?';
  const args = taskId === null ? [jobId] : [jobId, taskId];

  if (hasIntents) {
    const ambiguousClaim = database.prepare(`SELECT dispatch_key,task_id FROM provider_dispatch_intents
      WHERE job_id=?${taskClause} AND dispatch_claim_id IS NOT NULL AND provider_run_id IS NULL
      ORDER BY dispatch_claimed_at ASC,rowid ASC LIMIT 1`).get(...args);
    if (ambiguousClaim) return { kind: 'ambiguous_dispatch_claim', identity: ambiguousClaim.dispatch_key, taskId: ambiguousClaim.task_id };

    const boundIntents = database.prepare(`SELECT dispatch_key,task_id,provider_run_id FROM provider_dispatch_intents
      WHERE job_id=?${taskClause} AND provider_run_id IS NOT NULL ORDER BY updated_at ASC,rowid ASC`).all(...args);
    for (const intent of boundIntents) {
      if (!hasRuns) return { kind: 'provider_run_ledger_missing', identity: intent.dispatch_key, taskId: intent.task_id };
      if (!runHasJobId || !runHasTaskId) return {
        kind: 'provider_run_ledger_schema_incomplete', identity: intent.dispatch_key, taskId: intent.task_id
      };
      const run = database.prepare('SELECT provider_run_id,state FROM provider_runs WHERE provider_run_id=? AND job_id=? AND task_id=?')
        .get(String(intent.provider_run_id), jobId, intent.task_id);
      if (!run || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(run.state || '').toUpperCase())) {
        return { kind: run ? 'provider_run_not_terminal' : 'provider_run_binding_missing', identity: intent.provider_run_id, taskId: intent.task_id };
      }
    }
  }

  if (hasRuns && runHasJobId) {
    const activeRun = database.prepare(`SELECT provider_run_id,state,${runHasTaskId ? 'task_id' : 'NULL AS task_id'} FROM provider_runs
      WHERE job_id=?${taskId === null || !runHasTaskId ? '' : ' AND task_id=?'}
        AND UPPER(COALESCE(state,'')) NOT IN ('COMPLETED','FAILED','CANCELLED')
      ORDER BY ${columnExists(database, 'provider_runs', 'created_at') ? 'created_at' : 'provider_run_id'} ASC,rowid ASC LIMIT 1`)
      .get(...(taskId === null || !runHasTaskId ? [jobId] : args));
    if (activeRun) return { kind: 'provider_run_not_terminal', identity: activeRun.provider_run_id, taskId: activeRun.task_id };
  } else if (hasRuns) {
    const unscopedRun = database.prepare(`SELECT provider_run_id,state,${runHasTaskId ? 'task_id' : 'NULL AS task_id'} FROM provider_runs
      WHERE UPPER(COALESCE(state,'')) NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY rowid ASC LIMIT 1`).get();
    if (unscopedRun) return {
      kind: 'provider_run_ledger_schema_incomplete', identity: unscopedRun.provider_run_id, taskId: unscopedRun.task_id
    };
  }

  if (hasLeases) {
    const quarantinedLease = database.prepare(`SELECT lease.lease_id,lease.task_id,lease.attempt FROM task_leases lease
      WHERE lease.job_id=?${taskId === null ? '' : ' AND lease.task_id=?'} AND lease.state='FAILED'
        AND (COALESCE(lease.last_error,'') LIKE 'REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:%'
          OR EXISTS (SELECT 1 FROM events event WHERE event.job_id=lease.job_id
            AND event.type='task.lease.quarantined' AND json_valid(event.payload_json)
            AND json_extract(event.payload_json,'$.leaseId')=lease.lease_id))
      ORDER BY lease.issued_at ASC,lease.rowid ASC LIMIT 1`).get(...args);
    if (quarantinedLease) return {
      kind: 'quarantined_lease_remote_effect_unresolved', identity: quarantinedLease.lease_id,
      taskId: quarantinedLease.task_id
    };
  }

  if (hasNativeStartIntents) {
    const pendingNativeStart = database.prepare(`SELECT intent.task_id,intent.admission_idempotency_key
      FROM m12_native_specialist_start_intents intent
      LEFT JOIN m12_native_specialist_runtime runtime
        ON runtime.task_id=intent.task_id AND runtime.attempt=intent.attempt
      WHERE intent.job_id=?${taskId === null ? '' : ' AND intent.task_id=?'}
        AND (intent.state='STARTING' OR runtime.task_id IS NULL OR runtime.lease_id<>intent.lease_id OR
          runtime.owner_epoch<>intent.owner_epoch OR runtime.environment_id<>intent.environment_id OR
          runtime.node_id<>intent.node_id OR runtime.run_id<>intent.run_id)
      ORDER BY intent.created_at ASC,intent.rowid ASC LIMIT 1`).get(...args);
    if (pendingNativeStart) return {
      kind: 'native_start_outcome_unresolved', identity: pendingNativeStart.admission_idempotency_key,
      taskId: pendingNativeStart.task_id
    };
  }

  if (hasNativeRuntimes) {
    const nativeRuntime = database.prepare(`SELECT run_id,task_id,state FROM m12_native_specialist_runtime
      WHERE task_id IN (SELECT task_id FROM tasks WHERE job_id=?${taskId === null ? '' : ' AND task_id=?'})
        AND UPPER(COALESCE(state,'')) NOT IN ('COMPLETED','FAILED')
      ORDER BY created_at ASC,rowid ASC LIMIT 1`).get(...args);
    if (nativeRuntime) return {
      kind: 'native_runtime_not_terminal', identity: nativeRuntime.run_id, taskId: nativeRuntime.task_id
    };
  }
  return null;
}
