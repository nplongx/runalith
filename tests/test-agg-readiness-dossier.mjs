import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAggReadinessDossier } from '../scripts/build-agg-readiness-dossier.mjs';

const gates = [
  'PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED',
  'INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED',
  'PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED',
  'PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED',
  'ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN',
  'RUNNING_TASKS_MUST_DRAIN'
];

function fixture() {
  const candidateHash = 'a'.repeat(64);
  return {
    alignment: { status: 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT', byteIdentityStatus: 'PASS_EXACT_ARCHIVE_ENTRY_BYTES',
      bundleSha256: candidateHash, bundlePath: '/candidate.mcpb', bundleBytes: 1234, sourceSnapshotSha256: 'b'.repeat(64),
      sourceProvenanceStatus: 'CLEAN_GIT_TREE_MATCHED_NO_AUTHENTICATED_BUILD_RECEIPT', releaseEligibility: 'BLOCKED_AUTHENTICATED_BUILD_RECEIPT_AND_INDEPENDENT_AUTHORITY_REQUIRED',
      archiveEntryCount: 93, manifestToolCount: 74 },
    preflight: { readOnly: true, liveMutationPerformed: false, workflowDatabaseMutationPerformed: false,
      externalSecurityStoreMutationPerformed: false, candidate: { sha256: candidateHash, version: '1.0.9-rc.28', sizeBytes: 1234,
        smoke: { passed: true }, entryPoint: 'server/index-v1.0.9-rc.28.js' },
      host: { installedGeneration: { manifestVersion: '1.0.9-rc.26', entryPointSha256: 'c'.repeat(64) },
        trustConfiguration: { externalAntiRollbackAnchor: { verified: false, status: 'NOT_CONFIGURED' } } },
      decision: { status: 'BLOCKED', canActivateNow: false, blockers: [...gates, 'CANDIDATE_VERSION_ALREADY_INSTALLED'] } },
    reconciliation: { readOnly: true, generatedAt: '2026-10-28T08:00:00.000Z', summary: { consideredJobs: 1, matchingJobCount: 1,
      jobsFlaggedForReconciliation: 1 }, tableCounts: { jobs: 1, tasks: 2, events: 3, results: 0, artifacts: 0, attempts: 1, task_leases: 0, approvals: 0 },
      diagnostics: [{ jobId: 'job-a', state: 'EXECUTING', status: 'active', phase: 'EXECUTING', activeTaskId: 'task-a',
        ownerBinding: { authority: 'unresolved_owner_identity_not_persisted' }, runtimeObservation: { providerIdentity: 'not_persisted' },
        allJobEventIds: ['event-a'], tasks: [{ task: { taskId: 'task-a', status: 'running' }, latestAttempt: { attemptId: 'attempt-a' },
          recentResults: [], recentArtifacts: [], leases: [], flags: ['ACTIVE_ATTEMPT_WITHOUT_ACTIVE_LEASE'], lineageAssessment: { ownerAuthority: 'not_persisted' } }] }],
      adaptiveGoalGraph: { goals: [{ goalId: 'runalith-agg-e2e-20261026-clean', snapshotHash: 'd'.repeat(64) }],
        findings: [{ code: 'PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID', recordType: 'planner_evidence', recordId: 'run-a/hash-a', detail: 'source_hash_mismatch' }],
        plannerSummary: { totalRuns: 65, evidenceRecords: 373, evidenceClaimsReportedVerified: 0 },
        proposalSummary: { planGraphProposals: 3, planGraphSteps: 22, planGraphStepsMissingEvidence: 22,
          planGraphProposalsWithoutAuthenticatedSnapshotBinding: 3, planGraphProposalsWithUnverifiedSource: 3, executionGraphProposals: 0,
          executionPlanCandidateEvents: 0 } } },
    snapshot: { goal_id: 'runalith-agg-e2e-20261026-clean', verified: false, eligibleForAttestation: false,
      snapshot: { snapshot_hash: 'd'.repeat(64), nodes: Array.from({ length: 7 }, (_, i) => ({ id: `node-${i}`, evidence_refs: [] })),
        edges: Array.from({ length: 7 }, (_, i) => ({ id: `edge-${i}` })), memberships: Array.from({ length: 7 }, (_, i) => ({ id: `member-${i}` })),
        evidence_refs: [], integrity_valid: true }, evidenceManifest: [], evidenceManifestHash: 'e'.repeat(64),
      attestationBlockers: [{ code: 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY' }] },
    trustStatus: { status: 'blocked', domains: { goal_idea_verifier: { available: false, roots: [], blockers: [{ code: 'KNOWLEDGE_VERIFIER_NOT_CONFIGURED' }] },
      action_intent_reviewer: { available: false, roots: [], blockers: [{ code: 'AGG_TRUST_CONFIG_NOT_CONFIGURED' }] } },
      separation: { providerIdsDistinct: true, publicRootsDisjoint: true, sharedRootFingerprints: [] } }
  };
}

test('dossier keeps all six RC.23 gates open and separates byte alignment from release authority', () => {
  const d = buildAggReadinessDossier(fixture());
  assert.equal(d.decision.status, 'BLOCKED');
  assert.equal(d.candidate.archiveEntryCount, 93);
  assert.equal(d.candidate.toolCount, 74);
  assert.equal(d.checks.sourceToBundleByteAlignment, 'PASS');
  assert.equal(d.checks.sourceProvenanceAuthenticated, false);
  assert.deepEqual(d.rc23Gates.map(g => g.code), gates);
  assert.ok(d.rc23Gates.every(g => g.status === 'OPEN' && g.authorizationGranted === false));
});

test('structured but evidence-empty graph, unconfigured trust, missing Plan evidence and absent Execution proposals remain blockers', () => {
  const d = buildAggReadinessDossier(fixture());
  assert.equal(d.liveState.graph.nodeCount, 7);
  assert.equal(d.liveState.graph.evidenceReferenceCount, 0);
  assert.equal(d.liveState.graph.eligibleForAttestation, false);
  assert.equal(d.liveState.trustDomains.goal_idea_verifier.effectiveTrustVerified, false);
  assert.equal(d.liveState.trustDomains.action_intent_reviewer.effectiveTrustVerified, false);
  assert.equal(d.liveState.planGraph.stepsMissingSupportingEvidence, 22);
  assert.equal(d.liveState.executionGraph.persistedProposals, 0);
  assert.ok(d.findings.some(f => f.code === 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY'));
  assert.ok(d.findings.some(f => f.code === 'PLAN_GRAPH_SUPPORTING_EVIDENCE_MISSING'));
  assert.ok(d.findings.some(f => f.code === 'EXECUTION_GRAPH_PROPOSALS_NOT_PERSISTED'));
});

test('source hash mismatch is retained with unknown cause and no historical rewrite authorization', () => {
  const d = buildAggReadinessDossier(fixture());
  const f = d.findings.find(item => item.detail === 'source_hash_mismatch');
  assert.ok(f);
  assert.equal(f.sourceArtifact.name, 'reconciliation');
  assert.equal(f.sourceArtifact.recordId, f.recordId);
  assert.match(f.cause, /exact historical mutation\/capture cause is not established/);
  assert.match(f.prohibitedAction, /Do not rewrite historical digests/);
});

test('every actionable finding and workflow recovery record links to its exact source report and digest', () => {
  const input = fixture();
  input.reconciliation.__path = '/reports/reconciliation.json';
  input.reconciliation.__sha256 = '1'.repeat(64);
  input.preflight.__path = '/reports/preflight.json';
  input.preflight.__sha256 = '2'.repeat(64);
  input.snapshot.__path = '/reports/snapshot.json';
  input.snapshot.__sha256 = '3'.repeat(64);
  input.trustStatus.__path = '/reports/trust.json';
  input.trustStatus.__sha256 = '4'.repeat(64);
  const d = buildAggReadinessDossier(input);
  for (const finding of d.findings) {
    const artifacts = finding.sourceArtifacts || [finding.sourceArtifact];
    assert.ok(artifacts.length > 0 && artifacts.every(a => a.name && a.path && /^[a-f0-9]{64}$/.test(a.sha256)), finding.code);
  }
  assert.ok(d.rc23Gates.every(g => g.sourceArtifact.path === '/reports/preflight.json' && g.sourceArtifact.sha256 === '2'.repeat(64)));
  assert.ok(d.workflowRecovery.every(j => j.sourceArtifact.path === '/reports/reconciliation.json' && j.sourceArtifact.sha256 === '1'.repeat(64)));
});

test('running tasks with missing leases stay HOLD and never infer worker death', () => {
  const d = buildAggReadinessDossier(fixture());
  assert.equal(d.liveState.jobs.runningTasks, 1);
  assert.equal(d.liveState.jobs.runningTasksWithoutActiveLease, 1);
  assert.equal(d.workflowRecovery[0].action, 'HOLD_FOR_OWNER_RECONCILIATION');
  assert.equal(d.workflowRecovery[0].authorizationGranted, false);
  assert.match(d.rc23Gates.find(g => g.code === 'RUNNING_TASKS_MUST_DRAIN').forbidden, /Do not infer worker death/);
});

test('candidate hash disagreement and self-promoted graph verification fail closed', () => {
  const badHash = fixture();
  badHash.preflight.candidate.sha256 = 'f'.repeat(64);
  assert.throws(() => buildAggReadinessDossier(badHash), /candidate SHA-256 differs/);
  const promoted = fixture();
  promoted.snapshot.verified = true;
  assert.throws(() => buildAggReadinessDossier(promoted), /must retain its observed unverified/);
});

test('a missing RC.23 blocker is not auto-closed from omission', () => {
  const input = fixture();
  input.preflight.decision.blockers = input.preflight.decision.blockers.filter(code => code !== gates[0]);
  const d = buildAggReadinessDossier(input);
  assert.equal(d.rc23Gates[0].status, 'NOT_CLOSED_BY_THIS_EVIDENCE');
  assert.equal(d.rc23Gates[0].authorizationGranted, false);
});
