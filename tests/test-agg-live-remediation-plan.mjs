import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildAggLiveRemediationPlan } from '../scripts/build-agg-live-remediation-plan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts/build-agg-live-remediation-plan.mjs');
const sha = 'a'.repeat(64);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function proposal(jobId, options = {}) {
  return {
    kind: 'plan_graph_proposal', jobId, eventId: `event-${jobId}`, workflowState: 'APPROVED', fingerprint: sha,
    draftHash: sha, bindingHash: sha, sourceVerificationStatus: 'unverified', planStepIds: ['a', 'b'],
    checks: { knowledgeSnapshotBound: false, signatureVerificationPerformed: false },
    readinessAssessment: { stepCount: 2, missingEvidenceStepCount: 2 },
    stepEvidenceAssessments: [
      { stepId: 'a', sourceNodeId: 'node-a', blockerCode: 'STEP_EVIDENCE_MISSING', status: 'BLOCKED_MISSING_SUPPORTING_EVIDENCE', declaredReferenceCount: 0, verifiedReferenceCount: 0 },
      { stepId: 'b', sourceNodeId: 'node-b', blockerCode: 'STEP_EVIDENCE_MISSING', status: 'BLOCKED_MISSING_SUPPORTING_EVIDENCE', declaredReferenceCount: 0, verifiedReferenceCount: 0 }
    ], ...options
  };
}
function inputs() {
  const recoveryJob = {
    jobId: 'job-active', action: 'HOLD_FOR_OWNER_RECONCILIATION', authorizationGranted: false,
    idempotencyKey: 'reconcile-test', observedIdentity: {
      jobId: 'job-active', state: 'EXECUTING', status: 'active', activeTaskId: 'task-running', taskIds: ['task-running'],
      taskLineage: [{ taskId: 'task-running', status: 'running', latestAttempt: { attemptId: 'attempt-1', status: 'started' },
        results: [], artifacts: [], leases: [], eventIds: ['event-1'], flags: ['ACTIVE_ATTEMPT_WITHOUT_ACTIVE_LEASE'] }]
    }
  };
  return {
    dossier: { schemaVersion: 1, recordType: 'runalith-agg-live-readiness-dossier', generatedAt: '2026-10-28T09:00:00.000Z',
      candidate: { version: '1.0.9-rc.29', path: '/tmp/candidate.mcpb', sha256: sha, archiveEntryCount: 93, toolCount: 74,
        entryPoint: 'server/index-v1.0.9-rc.29.js' },
      findings: [
        { code: 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY', sourceArtifact: { path: '/tmp/snapshot.json', sha256: sha } },
        { code: 'KNOWLEDGE_VERIFIER_NOT_CONFIGURED' }, { code: 'AGG_TRUST_CONFIG_NOT_CONFIGURED' },
        { code: 'PLAN_GRAPH_SUPPORTING_EVIDENCE_MISSING' }, { code: 'EXECUTION_GRAPH_PROPOSALS_NOT_PERSISTED' },
        { code: 'PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID', recordId: 'planner-1', detail: 'source_hash_mismatch',
          sourceArtifact: { name: 'reconciliation', path: '/tmp/recon.json', sha256: sha, recordId: 'planner-1' },
          confidence: 'CONFIRMED_BY_CURRENT_READ_ONLY_REVALIDATION', cause: 'historical cause unresolved', owner: 'source owner not recorded',
          provider: 'not applicable', runtime: 'repository-bound read-only check', lease: 'not applicable',
          allowedAction: 'preserve and recapture', prohibitedAction: 'do not rewrite history', verifyAfter: 'fresh source evidence required' }
      ],
      liveState: { graph: { snapshotHash: sha } },
      evidenceInputs: [{ name: 'reconciliation', path: '/tmp/recon.json', sha256: sha }],
      rc23Gates: [{ code: 'PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED', owner: 'host security', missing: 'configs', verify: 'effective host config', forbidden: 'do not mint roots' }] },
    reconciliation: { schemaVersion: 1, readOnly: true, generatedAt: '2026-10-28T08:59:00.000Z',
      summary: { consideredJobs: 1 }, diagnostics: [{}], recoveryPlan: [recoveryJob],
      adaptiveGoalGraph: { goals: [{ goalId: 'runalith-agg-e2e-20261026-clean', nodeCount: 4, edgeCount: 5, membershipCount: 6,
          snapshotHash: 'b'.repeat(64), evidenceAssessment: { declaredReferenceCount: 2, eligibleForExternalAttestation: false } }],
        findings: [{ code: 'PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID', recordId: 'planner-1', detail: 'source_hash_mismatch', sourceArtifact: { path: '/tmp/recon.json', sha256: sha }, confidence: 'confirmed', cause: 'unknown' }],
        proposalRecords: [proposal('plan-1'), proposal('plan-2'), proposal('plan-3'), { kind: 'execution_graph_proposal', jobId: 'exec-1' }] } },
    preflight: { schemaVersion: 1, readOnly: true, liveMutationPerformed: false, workflowDatabaseMutationPerformed: false,
      generatedAt: '2026-10-28T09:01:00.000Z', candidate: { version: '1.0.9-rc.29', path: '/tmp/candidate.mcpb', sha256: sha,
        archiveEntryCount: 93, toolCount: 74, entryPoint: 'server/index-v1.0.9-rc.29.js', verified: true },
      decision: { status: 'BLOCKED', blockers: ['ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN'] } },
    inputArtifacts: [{ name: 'dossier', path: '/tmp/dossier.json', sha256: sha }, { name: 'reconciliation', path: '/tmp/recon.json', sha256: sha }]
  };
}

test('builds owner-authorized repair plan with precise findings and never authorizes live transitions', () => {
  const plan = buildAggLiveRemediationPlan({ ...inputs(), generatedAt: '2026-10-28T09:02:00.000Z' });
  assert.equal(plan.status, 'BLOCKED_NEEDS_OWNER_AUTHORITY_RECONCILIATION');
  assert.equal(plan.decision.canActivateNow, false);
  assert.equal(plan.decision.lifecycleMutationAuthorized, false);
  assert.equal(plan.currentFindings.sourceHashMismatchCount, 1);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.currentFindings.sourceHashMismatchRecords[0].sourceArtifact.recordId, 'planner-1');
  assert.equal(plan.currentFindings.sourceHashMismatchRecords[0].confidence, 'CONFIRMED_BY_CURRENT_READ_ONLY_REVALIDATION');
  assert.equal(plan.currentFindings.sourceHashMismatchRecords[0].owner, 'source owner not recorded');
  assert.equal(plan.currentFindings.sourceHashMismatchRecords[0].prohibitedAction, 'do not rewrite history');
  assert.equal(plan.currentFindings.planGraph.proposalCount, 3);
  assert.equal(plan.currentFindings.planGraph.missingSupportingEvidenceStepCount, 6);
  assert.equal(plan.currentFindings.planGraph.missingAuthenticatedSnapshotBindingCount, 3);
  assert.equal(plan.currentFindings.executionGraph.persistedProposalCount, 1);
  assert.deepEqual(plan.currentFindings.goalEvidence, { goalId: 'runalith-agg-e2e-20261026-clean', nodes: 4, edges: 5,
    memberships: 6, evidenceRefs: 2, attestationEligible: false, snapshotHash: 'b'.repeat(64),
    observationStatus: 'OBSERVED_IN_CURRENT_GRAPH_RECONCILIATION', finding: plan.currentFindings.goalEvidence.finding });
  assert.equal(plan.currentFindings.workflow.executingJobs, 1);
  assert.equal(plan.currentFindings.workflow.runningTasks, 1);
  assert.equal(plan.currentFindings.workflow.runningTasksWithoutLease, 1);
  assert.equal(plan.workflowRecovery.tasks[0].authorizationGranted, false);
  assert.ok(plan.workflowRecovery.tasks[0].prohibitedOperations.some(item => /missing lease/i.test(item)));
  assert.equal(plan.workflowRecovery.tasks[0].sourceEvidence.name, 'reconciliation');
  assert.equal(plan.workflowRecovery.tasks[0].sourceEvidence.sha256, sha);
  assert.equal(plan.workflowRecovery.tasks[0].sourceEvidence.rowFingerprint, null,
    'legacy schema-v1 fixture has no row fingerprint and must disclose the gap');
  assert.equal(plan.workflowRecovery.jobs[0].observedTaskLineage[0].taskId, 'task-running');
  assert.ok(plan.workflowRecovery.tasks[0].preconditions.some(item => /HOLD\/INDETERMINATE/.test(item)));
  assert.ok(plan.workflowRecovery.tasks[0].postRepairVerification.every(item => item.required && item.mustUseFreshRead && !item.mayCloseReleaseGateByItself));
  assert.ok(plan.sixGateAssessment.some(gate => gate.code === 'PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED' && !gate.closed));
  assert.ok(plan.repairSteps.some(step => step.code === 'EXECUTION_GRAPH_SOURCE_ATTESTATION_REQUIRED' || step.id === 'legacy-plan-graph-execution-promotion-denied'));
  assert.ok(plan.repairSteps.every(step => step.mutationAuthorized === false));
  assert.ok(plan.repairSteps.every(step => step.preconditions.length >= 4 && step.postRepairVerification.length === step.verifyAfter.length));
  assert.ok(plan.repairSteps.every(step => step.ownerEvidenceRequired.every(requirement => requirement.evidenceRequired &&
    requirement.authorityEvidenceId === null && requirement.independentlyVerified === false)));
  assert.match(plan.repairSteps.find(step => step.id === 'source-hash-mismatch-recapture').summary, /^1 planner record\(s\)/);
  assert.match(plan.repairSteps.find(step => step.id === 'plan-graph-evidence-and-snapshot-rebind').summary, /6 of 6 steps missing/);
  assert.equal(plan.operationalContract.noAutomaticRepairOrRetry, true);
});

test('does not invent Goal/Idea graph counts or evidence eligibility when the current reconciliation omits the goal', () => {
  const values = inputs();
  delete values.reconciliation.adaptiveGoalGraph.goals;
  const plan = buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:02:00.000Z' });
  assert.equal(plan.currentFindings.goalEvidence.nodes, null);
  assert.equal(plan.currentFindings.goalEvidence.edges, null);
  assert.equal(plan.currentFindings.goalEvidence.memberships, null);
  assert.equal(plan.currentFindings.goalEvidence.evidenceRefs, null);
  assert.equal(plan.currentFindings.goalEvidence.attestationEligible, null);
  assert.equal(plan.currentFindings.goalEvidence.observationStatus, 'NOT_PRESENT_IN_GRAPH_RECONCILIATION');
  assert.equal(plan.repairSteps.find(step => step.id === 'goal-idea-evidence-manifest-rebuild').affected[0].nodeCount, null);
});

test('recovery plan summaries and evidence requirements are derived from observed records, not hard-coded counts', () => {
  const values = inputs();
  values.reconciliation.adaptiveGoalGraph.findings.push({ code: 'PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID',
    recordId: 'planner-2', detail: 'source_hash_mismatch', sourceHash: 'b'.repeat(64), sourcePath: 'src/other.js' });
  values.reconciliation.adaptiveGoalGraph.proposalRecords[0].stepEvidenceAssessments[0] = {
    stepId: 'a', sourceNodeId: 'node-a', blockerCode: 'STEP_EVIDENCE_MISSING', status: 'BLOCKED_MISSING_SUPPORTING_EVIDENCE',
    declaredReferenceCount: 0, verifiedReferenceCount: 0
  };
  values.reconciliation.adaptiveGoalGraph.proposalRecords[0].stepEvidenceAssessments[1] = {
    stepId: 'b', sourceNodeId: 'node-b', blockerCode: null, status: 'VERIFIED', declaredReferenceCount: 1, verifiedReferenceCount: 1
  };
  const plan = buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:04:00.000Z' });
  assert.equal(plan.currentFindings.sourceHashMismatchCount, 2);
  assert.match(plan.repairSteps.find(step => step.id === 'source-hash-mismatch-recapture').summary, /^2 planner record\(s\)/);
  assert.match(plan.repairSteps.find(step => step.id === 'plan-graph-evidence-and-snapshot-rebind').summary, /5 of 6 steps missing/);
  assert.equal(plan.currentFindings.planGraph.missingSupportingEvidenceStepCount, 5);
  assert.equal(plan.decision.lifecycleMutationAuthorized, false);
  assert.equal(plan.decision.canActivateNow, false);
});

test('accepts schema-v2 reconciliation only when its metrics remain diagnostic-only and fail-closed', () => {
  const values = inputs();
  values.reconciliation.dbPath = '/tmp/workflow.db';
  const recoveryRow = structuredClone(values.reconciliation.recoveryPlan[0]);
  recoveryRow.observedIdentity.taskRowFingerprints = [{ taskId: 'task-running', sha256: sha }];
  recoveryRow.observedIdentity.taskEventIds = [{ taskId: 'task-running', eventIds: ['event-1'] }];
  delete recoveryRow.observedIdentity.taskLineage;
  const reconciliation = {
    ...values.reconciliation,
    schemaVersion: 2,
    recoveryPlan: [recoveryRow],
    readOnly: true, liveMutationPerformed: false, workflowDatabaseMutationPerformed: false, externalSecurityStoreMutationPerformed: false,
    diagnostics: [{ jobId: 'job-active', state: 'EXECUTING', tasks: [{
      task: { taskId: 'task-running', status: 'running', executionPid: null, executionSessionId: null },
      latestAttempt: { attemptId: 'attempt-1', status: 'started', runId: null }, recentResults: [], recentArtifacts: [], leases: [],
      lineageAssessment: { taskId: 'task-running', attemptIds: ['attempt-1'], resultIds: [], artifactIds: [], leaseIds: [],
        rowFingerprint: sha, eventPayloadFingerprint: 'b'.repeat(64), truncated: { attempts: false, results: false, artifacts: false, leases: false },
        ownerAuthority: 'not_persisted_in_supported_workflow_schema', providerIdentity: 'not_persisted_in_supported_workflow_schema' },
      lifecycleEvidence: { owner: { status: 'UNVERIFIED' }, provider: { status: 'UNVERIFIED' }, runtime: { status: 'MISSING' },
        lease: { status: 'MISSING_NOT_PROOF_OF_WORKER_DEATH' }, automaticLifecycleActionAuthorized: false },
      eventLineage: { eventIds: ['event-1'], eventTypes: ['attempt.started'], truncated: false }, flags: ['ACTIVE_ATTEMPT_WITHOUT_ACTIVE_LEASE']
    }] }],
    policy: { staleCandidateIsNotProofOfWorkerDeath: true, missingLeaseDoesNotAuthorizeTerminalization: true,
      callerMustVerifyHostAndProviderState: true, noAutomaticRecovery: true },
    operabilityMetrics: {
      status: 'DIAGNOSTIC_ONLY_NOT_RELEASE_EVIDENCE', automaticLifecycleActionsAuthorized: false,
      terminalDispositionProof: { status: 'NOT_ASSESSED_BY_LOCAL_SQLITE_DIAGNOSTIC', verifiedTerminalDispositions: 0 }
    }
  };
  reconciliation.dbPath = '/tmp/workflow.db';
  const lifecycleArtifact = { name: 'lifecycleReconciliation', path: '/tmp/lifecycle-v2.json', sha256: 'c'.repeat(64) };
  const plan = buildAggLiveRemediationPlan({ ...values, lifecycleReconciliation: reconciliation,
    inputArtifacts: [...values.inputArtifacts, lifecycleArtifact], generatedAt: '2026-10-28T09:03:00.000Z' });
  assert.equal(plan.currentFindings.workflow.executingJobs, 1);
  assert.equal(plan.currentFindings.workflow.runningTasksWithoutLease, 1);
  assert.equal(plan.currentFindings.workflow.runningTasks, 1,
    'schema-v2 diagnostics must be normalized even though its compact recovery plan has no taskLineage array');
  assert.equal(plan.workflowRecovery.tasks[0].sourceShape, 'schema_v2_diagnostic_task');
  assert.equal(plan.workflowRecovery.tasks[0].sourceEvidence.rowFingerprint, sha);
  assert.equal(plan.workflowRecovery.tasks[0].sourceEvidence.eventPayloadFingerprint, 'b'.repeat(64));
  assert.equal(plan.workflowRecovery.tasks[0].evidenceCompleteness.eventIdsTruncated, false);
  assert.equal(plan.workflowRecovery.jobs[0].observedTaskLineage[0].eventTypes[0], 'attempt.started');
  assert.equal(plan.workflowRecovery.tasks[0].authorizationGranted, false);
  assert.equal(plan.currentFindings.workflow.lifecycleSourceSchemaVersion, 2);
  assert.equal(plan.workflowRecovery.observationSource.name, 'lifecycleReconciliation');
  assert.equal(plan.workflowRecovery.tasks[0].sourceEvidence.name, 'lifecycleReconciliation');
  assert.ok(plan.sourceReports.some(item => item.name === 'reconciliation') && plan.sourceReports.some(item => item.name === 'lifecycleReconciliation'),
    'the graph dossier and lifecycle lineage must remain separately hash-bound source reports');
  assert.equal(plan.decision.lifecycleMutationAuthorized, false);
  assert.equal(plan.operationalContract.noAutomaticRepairOrRetry, true);

  assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: {
    ...reconciliation, operabilityMetrics: { ...reconciliation.operabilityMetrics, automaticLifecycleActionsAuthorized: true }
  } }), /schema-v2 reconciliation must retain diagnostic-only operability semantics/);
  const missingExternalMarker = { ...reconciliation };
  delete missingExternalMarker.externalSecurityStoreMutationPerformed;
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: missingExternalMarker }),
    /explicit no-mutation markers for runtime, workflow database and external security store/,
    'schema-v2 lifecycle input must explicitly deny an external security-store mutation too');
  for (const policyField of ['staleCandidateIsNotProofOfWorkerDeath', 'callerMustVerifyHostAndProviderState',
    'missingLeaseDoesNotAuthorizeTerminalization', 'noAutomaticRecovery']) {
    const policy = { ...reconciliation.policy };
    delete policy[policyField];
    assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: { ...reconciliation, policy } }),
      new RegExp('schema-v2 reconciliation must retain diagnostic-only operability semantics'),
      `schema-v2 must fail closed when policy.${policyField} is absent`);
  }
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: { ...reconciliation, schemaVersion: 3 } }),
    /separate lifecycle reconciliation must be a schema-v2 read-only report/);
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: { ...reconciliation, dbPath: '/tmp/other.db' } }),
    /same canonical workflow database path/);
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: {
    ...reconciliation, generatedAt: '2026-10-28T08:48:00.000Z'
  } }), /outside the ten-minute observation window/);
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: {
    ...reconciliation, diagnostics: []
  } }), /missing, duplicate or unmatched diagnostic\/recovery job records/);
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: {
    ...reconciliation, diagnostics: [...reconciliation.diagnostics, structuredClone(reconciliation.diagnostics[0])]
  } }), /missing, duplicate or unmatched diagnostic\/recovery job records/);
  const conflictingTask = structuredClone(reconciliation);
  conflictingTask.diagnostics[0].tasks[0].lineageAssessment.taskId = 'task-other';
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, generatedAt: '2026-10-28T09:03:00.000Z', lifecycleReconciliation: conflictingTask }),
    /missing, duplicate or conflicting task lineage/);
});

test('rejects input that is not explicitly read-only and refuses mismatched candidate/dossier identity at CLI boundary logic', () => {
  const values = inputs();
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, reconciliation: { ...values.reconciliation, readOnly: false } }),
    /reconciliation must be a supported schema-v1\/schema-v2 read-only report/);
  assert.throws(() => buildAggLiveRemediationPlan({ ...values, preflight: { ...values.preflight, liveMutationPerformed: true } }),
    /preflight must be schema-v1 and explicitly prove its operations were read-only/);
});

test('CLI binds separate graph and lifecycle reconciliation bytes and rejects stale or cross-DB lifecycle observations', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-remediation-dual-reconciliation-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'workflow.db');
  fs.writeFileSync(dbPath, 'synthetic path identity only\n', { flag: 'wx', mode: 0o600 });
  const graphCapturedAt = new Date().toISOString();
  const lifecycleCapturedAt = new Date(Date.parse(graphCapturedAt) + 1000).toISOString();
  const writeJson = (name, value) => {
    const file = path.join(dir, name);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return { path: file, sha256: digest(bytes) };
  };
  const values = inputs();
  const graph = structuredClone(values.reconciliation);
  graph.dbPath = dbPath;
  graph.generatedAt = graphCapturedAt;
  const recoveryRow = structuredClone(graph.recoveryPlan[0]);
  recoveryRow.observedIdentity.taskRowFingerprints = [{ taskId: 'task-running', sha256: sha }];
  recoveryRow.observedIdentity.taskEventIds = [{ taskId: 'task-running', eventIds: ['event-1'] }];
  delete recoveryRow.observedIdentity.taskLineage;
  const lifecycle = {
    schemaVersion: 2, generatedAt: lifecycleCapturedAt, readOnly: true,
    liveMutationPerformed: false, workflowDatabaseMutationPerformed: false, externalSecurityStoreMutationPerformed: false,
    dbPath, summary: { consideredJobs: 1 }, recoveryPlan: [recoveryRow],
    diagnostics: [{ jobId: 'job-active', state: 'EXECUTING', tasks: [{
      task: { taskId: 'task-running', status: 'running' },
      latestAttempt: { attemptId: 'attempt-1', status: 'started', runId: null },
      recentResults: [], recentArtifacts: [], leases: [],
      lineageAssessment: { taskId: 'task-running', attemptIds: ['attempt-1'], resultIds: [], artifactIds: [], leaseIds: [],
        rowFingerprint: sha, eventPayloadFingerprint: 'b'.repeat(64),
        truncated: { attempts: false, results: false, artifacts: false, leases: false },
        ownerAuthority: 'not_persisted_in_supported_workflow_schema', providerIdentity: 'not_persisted_in_supported_workflow_schema' },
      lifecycleEvidence: { owner: { status: 'UNVERIFIED' }, provider: { status: 'UNVERIFIED' }, runtime: { status: 'MISSING' },
        lease: { status: 'MISSING_NOT_PROOF_OF_WORKER_DEATH' }, automaticLifecycleActionAuthorized: false },
      eventLineage: { eventIds: ['event-1'], eventTypes: ['attempt.started'], truncated: false },
      flags: ['ACTIVE_ATTEMPT_WITHOUT_ACTIVE_LEASE']
    }] }],
    policy: { staleCandidateIsNotProofOfWorkerDeath: true, missingLeaseDoesNotAuthorizeTerminalization: true,
      callerMustVerifyHostAndProviderState: true, noAutomaticRecovery: true },
    operabilityMetrics: { status: 'DIAGNOSTIC_ONLY_NOT_RELEASE_EVIDENCE', automaticLifecycleActionsAuthorized: false,
      terminalDispositionProof: { status: 'NOT_ASSESSED_BY_LOCAL_SQLITE_DIAGNOSTIC', verifiedTerminalDispositions: 0 } }
  };
  const graphFile = writeJson('graph-reconciliation.json', graph);
  const lifecycleFile = writeJson('lifecycle-reconciliation.json', lifecycle);
  const dossier = structuredClone(values.dossier);
  dossier.evidenceInputs = dossier.evidenceInputs.map(item => item.name === 'reconciliation'
    ? { ...item, path: graphFile.path, sha256: graphFile.sha256 } : item);
  const dossierFile = writeJson('dossier.json', dossier);
  const preflightFile = writeJson('preflight.json', values.preflight);
  const output = path.join(dir, 'remediation-plan.json');
  const args = ['--dossier', dossierFile.path, '--reconciliation', graphFile.path,
    '--lifecycle-reconciliation', lifecycleFile.path, '--preflight', preflightFile.path, '--output', output];
  const run = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.status, 'BLOCKED_NEEDS_OWNER_AUTHORITY_RECONCILIATION');
  assert.equal(envelope.mutationAuthorized, false);
  const plan = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(plan.candidate.sha256, sha);
  assert.equal(plan.currentFindings.workflow.lifecycleSourceSchemaVersion, 2);
  assert.equal(plan.workflowRecovery.tasks.length, 1);
  assert.equal(plan.workflowRecovery.tasks[0].sourceEvidence.sha256, lifecycleFile.sha256);
  assert.equal(plan.workflowRecovery.observationSource.sha256, lifecycleFile.sha256);
  assert.equal(plan.sourceReports.find(item => item.name === 'reconciliation').sha256, graphFile.sha256);
  assert.equal(plan.sourceReports.find(item => item.name === 'lifecycleReconciliation').sha256, lifecycleFile.sha256);
  assert.equal(plan.decision.lifecycleMutationAuthorized, false);

  const graphOnlyArgs = [...args];
  const lifecycleFlagIndex = graphOnlyArgs.indexOf('--lifecycle-reconciliation');
  graphOnlyArgs.splice(lifecycleFlagIndex, 2);
  const noLifecycleOutput = path.join(dir, 'graph-only-plan.json');
  graphOnlyArgs[graphOnlyArgs.indexOf('--output') + 1] = noLifecycleOutput;
  const graphOnly = spawnSync(process.execPath, [CLI_PATH, ...graphOnlyArgs], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(graphOnly.status, 2);
  assert.match(graphOnly.stderr, /--lifecycle-reconciliation is required/);
  assert.equal(fs.existsSync(noLifecycleOutput), false, 'schema-v1 graph-only input must not yield an incomplete remediation plan');

  const staleLifecycle = structuredClone(lifecycle);
  staleLifecycle.generatedAt = new Date(Date.parse(graphCapturedAt) - 11 * 60 * 1000).toISOString();
  const staleFile = writeJson('lifecycle-stale.json', staleLifecycle);
  const staleOutput = path.join(dir, 'stale-plan.json');
  const stale = spawnSync(process.execPath, [CLI_PATH, '--dossier', dossierFile.path, '--reconciliation', graphFile.path,
    '--lifecycle-reconciliation', staleFile.path, '--output', staleOutput], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /ten-minute observation window/);
  assert.equal(fs.existsSync(staleOutput), false, 'a stale lineage report must not produce a remediation plan');

  const otherDbLifecycle = structuredClone(lifecycle);
  otherDbLifecycle.dbPath = path.join(dir, 'other-workflow.db');
  const otherDbFile = writeJson('lifecycle-other-db.json', otherDbLifecycle);
  const otherDbOutput = path.join(dir, 'other-db-plan.json');
  const otherDb = spawnSync(process.execPath, [CLI_PATH, '--dossier', dossierFile.path, '--reconciliation', graphFile.path,
    '--lifecycle-reconciliation', otherDbFile.path, '--output', otherDbOutput], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 });
  assert.equal(otherDb.status, 2);
  assert.match(otherDb.stderr, /same canonical workflow database path/);
  assert.equal(fs.existsSync(otherDbOutput), false, 'cross-DB lineage must not produce a remediation plan');
});
