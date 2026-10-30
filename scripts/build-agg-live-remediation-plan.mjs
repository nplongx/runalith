#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function fail(message) {
  const error = new Error(message);
  error.code = 'AGG_REMEDIATION_PLAN_INPUT_INVALID';
  throw error;
}

function readRegularJson(filePath, label) {
  const absolute = path.resolve(filePath);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    fail(`${label} must be a canonical, non-symlink regular file: ${absolute}`);
  }
  const bytes = fs.readFileSync(absolute);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${String(error?.message || error)}`); }
  return { absolute, sha256: sha256(bytes), bytes: bytes.length, value };
}

function inputArtifact(name, record) {
  return { name, path: record.absolute, sha256: record.sha256, sizeBytes: record.bytes,
    generatedAt: record.value.generatedAt || null, semanticAuthority: 'local diagnostic evidence; not independent authorization' };
}

function repairStep({ id, priority, code, summary, certainty, affected, ownerAuthority, allowedReadOnly, requiredAfterAuthority,
  prohibited, verifyAfter, evidence }) {
  return {
    id, priority, code, status: 'NEEDS_OWNER_OR_AUTHORITY_ACTION', summary, certainty,
    affected, ownerAuthority, allowedOperationsBeforeAuthorization: allowedReadOnly,
    requiredOperationsAfterAuthority: requiredAfterAuthority,
    preconditions: [
      'Re-read the exact source records through their authoritative read-only API immediately before any proposed transition.',
      'Bind the current source snapshot, record IDs, content fingerprints and observation time; discard this plan if any binding has drifted.',
      'Record the named owner/provider/security authority decision and its independently verifiable evidence; this local plan is not that evidence.',
      'Keep the item on HOLD when owner, provider/runtime, attempt/result/artifact lineage or fencing state is missing or contradictory.'
    ],
    prohibitedOperations: prohibited,
    verifyAfter,
    postRepairVerification: (verifyAfter || []).map((criterion, index) => ({
      id: `${id}-verify-${index + 1}`, criterion, required: true,
      mustUseFreshRead: true, independentAuthorityRequired: /independent|authoritative|owner|provider|host|trusted|signed|attest|checkpoint|ledger/i.test(criterion),
      mayCloseReleaseGateByItself: false
    })),
    ownerEvidenceRequired: (ownerAuthority || []).map((role, index) => ({ role, evidenceRequired: true,
      authorityEvidenceId: null, independentlyVerified: false, ownerRequirementId: `${id}-authority-${index + 1}` })),
    evidence: evidence || [],
    mutationAuthorized: false
  };
}

/** Build a plan only. This function never opens the live workflow database or invokes runtime tools. */
export function buildAggLiveRemediationPlan({ dossier, reconciliation, lifecycleReconciliation = null, preflight = null,
  inputArtifacts = [], generatedAt = new Date().toISOString() }) {
  if (dossier?.recordType !== 'runalith-agg-live-readiness-dossier' || dossier?.schemaVersion !== 1) {
    fail('readiness dossier schema/type is unsupported');
  }
  if (![1, 2].includes(reconciliation?.schemaVersion) || reconciliation?.readOnly !== true ||
      !Array.isArray(reconciliation?.diagnostics) || !Array.isArray(reconciliation?.recoveryPlan)) {
    fail('reconciliation must be a supported schema-v1/schema-v2 read-only report with diagnostics and per-job recovery plan');
  }
  const lifecycle = lifecycleReconciliation || reconciliation;
  if (lifecycleReconciliation && (lifecycleReconciliation.schemaVersion !== 2 || lifecycleReconciliation.readOnly !== true ||
      lifecycleReconciliation.liveMutationPerformed !== false || lifecycleReconciliation.workflowDatabaseMutationPerformed !== false ||
      lifecycleReconciliation.externalSecurityStoreMutationPerformed !== false)) {
    fail('separate lifecycle reconciliation must be a schema-v2 read-only report with explicit no-mutation markers for runtime, workflow database and external security store');
  }
  if (lifecycleReconciliation && (typeof reconciliation.dbPath !== 'string' || typeof lifecycleReconciliation.dbPath !== 'string' ||
      path.resolve(reconciliation.dbPath) !== reconciliation.dbPath ||
      path.resolve(lifecycleReconciliation.dbPath) !== lifecycleReconciliation.dbPath ||
      reconciliation.dbPath !== lifecycleReconciliation.dbPath)) {
    fail('graph and lifecycle reconciliations must observe the same canonical workflow database path');
  }
  if (lifecycleReconciliation && (!Array.isArray(lifecycleReconciliation.diagnostics) || !Array.isArray(lifecycleReconciliation.recoveryPlan))) {
    fail('separate lifecycle reconciliation must include diagnostics and a per-job recovery plan');
  }
  if (lifecycleReconciliation) {
    const graphAt = Date.parse(reconciliation.generatedAt || '');
    const lifecycleAt = Date.parse(lifecycleReconciliation.generatedAt || '');
    const planAt = Date.parse(generatedAt || '');
    if (!Number.isFinite(graphAt) || !Number.isFinite(lifecycleAt) || !Number.isFinite(planAt) ||
        Math.abs(graphAt - lifecycleAt) > 10 * 60 * 1000 ||
        graphAt > planAt + 30_000 || lifecycleAt > planAt + 30_000 ||
        planAt - graphAt > 10 * 60 * 1000 || planAt - lifecycleAt > 10 * 60 * 1000) {
      fail('graph and lifecycle reconciliation timestamps are missing or outside the ten-minute observation window');
    }
  }
  if (lifecycle.schemaVersion === 2 &&
      (lifecycle.operabilityMetrics?.status !== 'DIAGNOSTIC_ONLY_NOT_RELEASE_EVIDENCE' ||
       lifecycle.operabilityMetrics?.automaticLifecycleActionsAuthorized !== false ||
       lifecycle.operabilityMetrics?.terminalDispositionProof?.status !== 'NOT_ASSESSED_BY_LOCAL_SQLITE_DIAGNOSTIC' ||
       lifecycle.policy?.staleCandidateIsNotProofOfWorkerDeath !== true ||
       lifecycle.policy?.missingLeaseDoesNotAuthorizeTerminalization !== true ||
       lifecycle.policy?.callerMustVerifyHostAndProviderState !== true ||
       lifecycle.policy?.noAutomaticRecovery !== true)) {
    fail('schema-v2 reconciliation must retain diagnostic-only operability semantics and explicitly deny lifecycle authority');
  }
  if (lifecycle.schemaVersion === 2) {
    const diagnosticIds = lifecycle.diagnostics.map(item => item?.jobId);
    const recoveryIds = lifecycle.recoveryPlan.map(item => item?.jobId);
    if (diagnosticIds.some(id => typeof id !== 'string' || !id) || recoveryIds.some(id => typeof id !== 'string' || !id) ||
        new Set(diagnosticIds).size !== diagnosticIds.length || new Set(recoveryIds).size !== recoveryIds.length ||
        diagnosticIds.length !== recoveryIds.length || diagnosticIds.some(id => !recoveryIds.includes(id))) {
      fail('schema-v2 lifecycle report has missing, duplicate or unmatched diagnostic/recovery job records');
    }
    for (const job of lifecycle.diagnostics) {
      const taskIds = (job.tasks || []).map(entry => entry?.task?.taskId || entry?.lineageAssessment?.taskId);
      if (taskIds.some(id => typeof id !== 'string' || !id) || new Set(taskIds).size !== taskIds.length ||
          (job.tasks || []).some(entry => entry.lineageAssessment?.taskId && entry.task?.taskId &&
            entry.lineageAssessment.taskId !== entry.task.taskId)) {
        fail(`schema-v2 lifecycle report has missing, duplicate or conflicting task lineage for job ${job.jobId}`);
      }
    }
  }
  if (preflight && (preflight.schemaVersion !== 1 || preflight.readOnly !== true ||
      preflight.liveMutationPerformed !== false || preflight.workflowDatabaseMutationPerformed !== false)) {
    fail('preflight must be schema-v1 and explicitly prove its operations were read-only');
  }
  const graph = reconciliation.adaptiveGoalGraph || {};
  const proposalRecords = Array.isArray(graph.proposalRecords) ? graph.proposalRecords : [];
  const planProposals = proposalRecords.filter(record => record.kind === 'plan_graph_proposal');
  const executionProposals = proposalRecords.filter(record => record.kind === 'execution_graph_proposal');
  const hashMismatches = (graph.findings || []).filter(record => record.detail === 'source_hash_mismatch' || record.code === 'PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID');
  const dossierFindingsByRecord = new Map((dossier.findings || []).filter(item => item?.recordId)
    .map(item => [`${item.code || ''}\0${item.recordId}\0${item.detail || ''}`, item]));
  const missingEvidenceSteps = planProposals.flatMap(proposal => (proposal.stepEvidenceAssessments || [])
    .filter(step => step.blockerCode === 'STEP_EVIDENCE_MISSING' || step.status === 'BLOCKED_MISSING_SUPPORTING_EVIDENCE')
    .map(step => ({ jobId: proposal.jobId, proposalEventId: proposal.eventId, stepId: step.stepId, sourceNodeId: step.sourceNodeId,
      declaredReferenceCount: step.declaredReferenceCount, verifiedReferenceCount: step.verifiedReferenceCount,
      status: step.status, blockerCode: step.blockerCode })));
  const missingSnapshotBindings = planProposals.filter(proposal => proposal.checks?.knowledgeSnapshotBound !== true ||
    proposal.checks?.signatureVerificationPerformed !== true || proposal.sourceVerificationStatus !== 'verified');
  const recoveryRows = lifecycle.recoveryPlan;
  const diagnosticsByJob = new Map((lifecycle.diagnostics || []).map(job => [job.jobId, job]));
  // Schema v2 intentionally puts full per-task diagnostic lineage under
  // diagnostics[].tasks and keeps recoveryPlan[].observedIdentity compact.
  // Accepting v2 while reading only the v1 taskLineage shape silently reported
  // zero running tasks and emitted empty per-record repair instructions. Prefer
  // the explicit legacy lineage when present; otherwise normalize v2 records
  // without upgrading any diagnostic field into authority.
  const taskRecords = recoveryRows.flatMap(job => {
    const legacyTasks = job.observedIdentity?.taskLineage;
    if (Array.isArray(legacyTasks)) return legacyTasks.map(task => ({ jobId: job.jobId,
      jobState: job.observedIdentity?.state || null, taskId: task.taskId, taskStatus: task.status,
      latestAttempt: task.latestAttempt || null, results: task.results || [], artifacts: task.artifacts || [], leases: task.leases || [],
      providerRuns: task.providerRuns || [], providerRunSchemaStatus: task.providerRunSchemaStatus || 'UNAVAILABLE_IN_SOURCE_REPORT',
      eventIds: task.eventIds || [], flags: task.flags || [], providerRunIdentityBinding: task.providerRunIdentityBinding || 'unavailable',
      rowFingerprint: task.rowFingerprint || job.observedIdentity?.taskRowFingerprints?.find(item => item.taskId === task.taskId)?.sha256 || null,
      eventPayloadFingerprint: task.eventPayloadFingerprint || null, eventTypes: task.eventTypes || [],
      lineageAssessment: task.lineageAssessment || null, lifecycleEvidence: task.lifecycleEvidence || null,
      truncation: task.truncation || null, sourceShape: 'schema_v1_recovery_plan' }));
    const diagnostic = diagnosticsByJob.get(job.jobId);
    return (diagnostic?.tasks || []).map(entry => ({ jobId: job.jobId, jobState: diagnostic.state || job.observedIdentity?.state || null,
      taskId: entry.task?.taskId || entry.lineageAssessment?.taskId || null, taskStatus: entry.task?.status || null,
      task: entry.task || null, latestAttempt: entry.latestAttempt || null, results: entry.recentResults || [],
      artifacts: entry.recentArtifacts || [], leases: entry.leases || [], providerRuns: entry.providerRuns || [],
      providerRunSchemaStatus: entry.providerRunSchemaStatus || 'UNAVAILABLE_IN_SOURCE_REPORT', eventIds: entry.eventLineage?.eventIds || [],
      eventTypes: entry.eventLineage?.eventTypes || [], flags: entry.flags || [],
      providerRunIdentityBinding: entry.lineageAssessment?.providerIdentity || entry.lifecycleEvidence?.provider?.status || 'unavailable',
      rowFingerprint: entry.lineageAssessment?.rowFingerprint || null,
      eventPayloadFingerprint: entry.lineageAssessment?.eventPayloadFingerprint || null,
      lineageAssessment: entry.lineageAssessment || null, lifecycleEvidence: entry.lifecycleEvidence || null,
      truncation: { ...(entry.lineageAssessment?.truncated || {}), events: entry.eventLineage?.truncated ?? null },
      sourceShape: 'schema_v2_diagnostic_task' }));
  }).filter(task => typeof task.taskId === 'string' && task.taskId);
  const runningTasks = taskRecords.filter(task => String(task.taskStatus).toLowerCase() === 'running');
  const executingJobs = recoveryRows.filter(row => row.observedIdentity?.state === 'EXECUTING');
  const goalEmptyEvidenceFinding = (dossier.findings || []).find(finding => finding.code === 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY');
  const targetGoalId = 'runalith-agg-e2e-20261026-clean';
  const targetGoal = (graph.goals || []).find(goal => goal.goalId === targetGoalId) || null;
  const targetGoalEvidence = targetGoal?.evidenceAssessment || null;
  const verifierMissingFinding = (dossier.findings || []).find(finding => finding.code === 'KNOWLEDGE_VERIFIER_NOT_CONFIGURED');
  const reviewerMissingFinding = (dossier.findings || []).find(finding => finding.code === 'AGG_TRUST_CONFIG_NOT_CONFIGURED');
  const proposalEvidenceFinding = (dossier.findings || []).find(finding => finding.code === 'PLAN_GRAPH_SUPPORTING_EVIDENCE_MISSING');
  const executionMissingFinding = (dossier.findings || []).find(finding => finding.code === 'EXECUTION_GRAPH_PROPOSALS_NOT_PERSISTED');
  const gateBlockers = preflight?.decision?.blockers || dossier.rc23Gates?.map(gate => gate.code) || [];

  const allowedReadOnly = [
    'Re-query through read-only source APIs and collect exact snapshot, proposal/event IDs, attempt/result/artifact lineage and current lease/runtime observations.',
    'Verify authority and source identity out-of-band; record the approving owner/provider decision before requesting any state transition.'
  ];
  const lifecycleProhibitions = [
    'Do not reset, terminalize, retry, drain, approve, dispatch, cancel, or delete any live workflow/task based only on age or missing lease.',
    'Do not edit historical planner rows, attestations, source hashes, artifact contents, or append-only history to make diagnostics green.',
    'Do not treat a report digest, valid artifact structure, test-local key, or caller-authored provenance as independent authority.'
  ];

  const steps = [];
  if (hashMismatches.length) steps.push(repairStep({
    id: 'source-hash-mismatch-recapture', priority: 'P0', code: 'PLANNER_SOURCE_BYTES_REPORTED_VERIFIED_BUT_CURRENT_SOURCE_INVALID',
    summary: `${hashMismatches.length} planner record(s) claim a source digest that does not match current source bytes; the historical mutation/capture cause is unknown.`,
    certainty: 'CONFIRMED_MISMATCH_CAUSE_UNRESOLVED',
    affected: hashMismatches.map(item => {
      const enriched = dossierFindingsByRecord.get(`${item.code || ''}\0${item.recordId || ''}\0${item.detail || ''}`) || null;
      return { recordId: item.recordId || null, detail: item.detail || null,
        sourceArtifact: enriched?.sourceArtifact || item.sourceArtifact || null,
        currentSourcePath: item.sourcePath || item.path || null, claimedSha256: item.sourceHash || item.claimedHash || null,
        confidence: enriched?.confidence || item.confidence || 'NOT_RECORDED_BY_SOURCE',
        cause: enriched?.cause || item.cause || 'Historical capture/mutation cause is not established by available evidence.',
        owner: enriched?.owner || item.owner || 'UNRESOLVED_NOT_RECORDED',
        provider: enriched?.provider || item.provider || 'UNRESOLVED_NOT_RECORDED',
        runtime: enriched?.runtime || item.runtime || 'UNRESOLVED_NOT_RECORDED',
        lease: enriched?.lease || item.lease || 'UNRESOLVED_NOT_RECORDED',
        allowedAction: enriched?.allowedAction || item.allowedAction || 'READ_ONLY_SOURCE_RECAPTURE_AFTER_OWNER_RECONCILIATION',
        prohibitedAction: enriched?.prohibitedAction || item.prohibitedAction || 'DO_NOT_REWRITE_HISTORICAL_EVIDENCE_OR_PROMOTE_UNVERIFIED_SOURCE',
        verifyAfter: enriched?.verifyAfter || item.verifyAfter || 'Fresh source and producer/result/attempt/event lineage must independently revalidate; preserve the historical record.' };
    }),
    ownerAuthority: ['Source artifact owner must identify the exact source revision and explain historical capture/mutation.', 'Planner/evidence producer owner must re-emit a new record only after source bytes are independently verified.'],
    allowedReadOnly,
    requiredAfterAuthority: ['Preserve existing historical rows; do not rewrite their claimed hashes.', 'Resolve the canonical source bytes and independently verify them, then create a new source record tied to the new producer run and content hash.'],
    prohibited: lifecycleProhibitions,
    verifyAfter: ['Current resolver reports the new source record as byte-integrity verified.', 'New planner record binds the producer run, canonical path, exact SHA-256 and report source; historical mismatch record remains unchanged.', 'Do not upgrade claim truth/independence without an independent attestation.'],
    evidence: inputArtifacts.filter(item => /reconciliation|dossier/.test(item.name))
  }));

  if (goalEmptyEvidenceFinding) steps.push(repairStep({
    id: 'goal-idea-evidence-manifest-rebuild', priority: 'P0', code: 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY',
    summary: 'The target Goal/Idea snapshot is structurally valid but contains no evidence references, so the verifier must remain ineligible to attest it.',
    certainty: 'CONFIRMED_BY_CAPTURED_READ_ONLY_SNAPSHOT',
    affected: [{ goalId: targetGoalId, snapshotHash: targetGoal?.snapshotHash || dossier.liveState?.graph?.snapshotHash || null,
      nodeCount: targetGoal?.nodeCount ?? null, edgeCount: targetGoal?.edgeCount ?? null,
      membershipCount: targetGoal?.membershipCount ?? null,
      evidenceRefCount: targetGoalEvidence?.declaredReferenceCount ?? null, sourceFinding: goalEmptyEvidenceFinding }],
    ownerAuthority: ['Each upstream evidence producer owns the actual result/artifact lineage.', 'Goal/Idea graph owner authorizes a new revision if membership or evidence references change.', 'Independent Goal/Idea verifier authority must verify claims and independence; it cannot be replaced by the graph caller.'],
    allowedReadOnly,
    requiredAfterAuthority: ['Identify expected evidence for each node from real producer result/artifact/completion lineage.', 'Publish only actual content-addressed artifact:// references whose producer lineage, schema, status and hashes revalidate.', 'Create a new graph revision/snapshot; do not backfill fabricated references or edit past revisions.', 'Re-query the exact snapshot, verify a non-empty eligible evidence manifest, then request a fresh independent attestation bound to that snapshot hash.'],
    prohibited: lifecycleProhibitions,
    verifyAfter: ['Snapshot reports evidence references and a non-empty manifest; each entry resolves through active artifact and successful producer result/attempt/event lineage.', 'Verifier returns eligibleForAttestation=true only after all evidence checks pass; trusted attestation independently binds exact current revisions/hash and is read back.', 'The prior empty snapshot and its digest remain available as historical evidence.'],
    evidence: [goalEmptyEvidenceFinding.sourceArtifact, ...inputArtifacts.filter(item => /reconciliation|dossier/.test(item.name))].filter(Boolean)
  }));

  if (planProposals.length) steps.push(repairStep({
    id: 'plan-graph-evidence-and-snapshot-rebind', priority: 'P0', code: 'PLAN_GRAPH_SUPPORTING_EVIDENCE_MISSING',
    summary: `Durable Plan Graph review proposals have ${missingEvidenceSteps.length} of ${planProposals.reduce((sum, proposal) => sum + (proposal.readinessAssessment?.stepCount || proposal.planStepIds?.length || 0), 0)} steps missing supporting evidence and lack authenticated current-snapshot bindings.`,
    certainty: 'CONFIRMED_BY_CAPTURED_PROPOSAL_EVENT_AND_EVIDENCE_ASSESSMENTS',
    affected: planProposals.map(proposal => ({ jobId: proposal.jobId, eventId: proposal.eventId, state: proposal.workflowState,
      fingerprint: proposal.fingerprint, draftHash: proposal.draftHash, bindingHash: proposal.bindingHash,
      sourceVerificationStatus: proposal.sourceVerificationStatus,
      knowledgeSnapshotBound: proposal.checks?.knowledgeSnapshotBound === true,
      signatureVerificationPerformed: proposal.checks?.signatureVerificationPerformed === true,
      missingEvidenceSteps: (proposal.stepEvidenceAssessments || []).filter(step => step.blockerCode === 'STEP_EVIDENCE_MISSING').map(step => ({ stepId: step.stepId,
        sourceNodeId: step.sourceNodeId, declaredReferenceCount: step.declaredReferenceCount, verifiedReferenceCount: step.verifiedReferenceCount })) })),
    observedMissingEvidenceStepCount: missingEvidenceSteps.length,
    ownerAuthority: ['Producer owner for each missing supporting artifact.', 'Goal/Idea graph owner for a new authenticated snapshot revision.', 'Independent verifier and human reviewer authorities for the exact new source and proposal.'],
    allowedReadOnly,
    requiredAfterAuthority: ['Do not promote these legacy review records. Start from a current, independently attested Goal/Idea snapshot with a non-empty manifest.', 'Resolve each Plan Graph step against a real supporting artifact and exact producer lineage; rebuild the Plan Graph and current-snapshot binding from source, rather than patching stored proposal JSON.', 'Create and approve a new review wrapper after verifying the exact immutable mapping and evidence.'],
    prohibited: lifecycleProhibitions,
    verifyAfter: ['Every step has non-empty supporting evidence, valid active artifact content hash/schema, successful completed producer result and exact canonical completion/event lineage.', 'The stored source snapshot hash, attestation ID, root fingerprint, evidence-manifest hash and membership/revision set reproduce from current trusted store.', 'A new persisted Plan Graph proposal readback reproduces fingerprint/draft/binding hashes; old proposal bytes are unchanged.'],
    evidence: inputArtifacts.filter(item => /reconciliation|dossier/.test(item.name))
  }));

  if (missingSnapshotBindings.length) steps.push(repairStep({
    id: 'legacy-plan-graph-execution-promotion-denied', priority: 'P0', code: 'AUTHENTICATED_CURRENT_SNAPSHOT_BINDING_MISSING',
    summary: 'Three existing Plan Graph proposal records do not bind an authenticated current Goal/Idea snapshot; current RC.29 source now blocks their promotion into a new Execution Graph.',
    certainty: 'CONFIRMED_FOR_CAPTURED_PROPOSALS; CAUSE_AND_OWNER_APPROVAL_PENDING',
    affected: missingSnapshotBindings.map(proposal => ({ jobId: proposal.jobId, eventId: proposal.eventId, fingerprint: proposal.fingerprint,
      sourceVerificationStatus: proposal.sourceVerificationStatus, knowledgeSnapshotBound: proposal.checks?.knowledgeSnapshotBound === true,
      signatureVerificationPerformed: proposal.checks?.signatureVerificationPerformed === true })),
    ownerAuthority: ['Goal/Idea graph and proposal owner must approve a new source-backed proposal.', 'Independent verifier must attest the exact current snapshot.', 'Human reviewer may approve only the newly revalidated review checklist; that approval is not source attestation or execution authority.'],
    allowedReadOnly,
    requiredAfterAuthority: ['Retain the old rows as historical review records.', 'Create a new Plan Graph from the authenticated current-snapshot API path and verify its exact persisted readback.', 'Use the RC.29 gate requiring authenticated source proof at Execution Graph creation and readback.'],
    prohibited: lifecycleProhibitions,
    verifyAfter: ['Legacy proposal remains unable to create an Execution Graph; guard returns EXECUTION_GRAPH_SOURCE_ATTESTATION_REQUIRED and persists no job.', 'Fresh attested Plan Graph proposal reproduces its bound current snapshot and only then passes Execution Graph readiness.', 'Reviewer identity and action-scoped approval are independently checked again at plan pinning and dispatch.'],
    evidence: inputArtifacts.filter(item => /reconciliation|dossier/.test(item.name))
  }));

  steps.push(repairStep({
    id: 'execution-graph-proposal-seeding', priority: 'P1', code: 'EXECUTION_GRAPH_PROPOSALS_NOT_PERSISTED',
    summary: `${executionProposals.length} persisted Execution Graph proposals were observed; do not create one until upstream attestation and all Plan-step evidence gates pass.`,
    certainty: 'COUNT_DERIVED_FROM_DURABLE_PROPOSAL_RECORD_SCAN',
    affected: executionProposals.map(proposal => ({ jobId: proposal.jobId, eventId: proposal.eventId, fingerprint: proposal.fingerprint })),
    ownerAuthority: ['Current authenticated Plan Graph owner/reviewer.', 'All supporting evidence producers.', 'Independent action-intent reviewer authority before candidate approval/dispatch.'],
    allowedReadOnly,
    requiredAfterAuthority: ['Resolve every Plan Graph supporting evidence reference and rebuild a current proposal from the source.', 'Create a persisted review-only Execution Graph under RC.29 and read it back from durable events.', 'Keep execution authorization and dispatch disabled until current reviewer attestation, immutable plan pinning and normal approval all bind the exact candidate.'],
    prohibited: lifecycleProhibitions,
    verifyAfter: ['One durable proposal event per fingerprint; exact event/job linkage, canonical payload/hash round-trip and fresh rebuild readback.', 'No action intent reaches an executable task unless the fresh candidate, current source snapshot, reviewer attestation and immutable plan all match.', 'Dispatch guard re-evaluates source/evidence/reviewer/approval at the final transaction boundary.'],
    evidence: inputArtifacts.filter(item => /reconciliation|dossier/.test(item.name))
  }));

  if (verifierMissingFinding || reviewerMissingFinding) steps.push(repairStep({
    id: 'host-managed-agg-trust-provisioning', priority: 'P0', code: 'PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED',
    summary: 'Verifier and/or reviewer production JSON trust configuration is unavailable in the observed host; do not generate roots or substitute test keys.',
    certainty: 'CONFIRMED_MISSING_FROM_CAPTURED_HOST_STATUS',
    affected: [{ verifier: verifierMissingFinding || null, reviewer: reviewerMissingFinding || null }],
    ownerAuthority: ['Host/security administrator for effective configuration, runtime identity and ledger.', 'Independent Goal/Idea verifier authority.', 'Separate action-intent reviewer authority.'],
    allowedReadOnly,
    requiredAfterAuthority: ['Provision exact schema-v1 public-key-only JSON through host-managed user configuration; domains/scopes must be exact, provider IDs distinct, canonical Ed25519 SPKI roots disjoint.', 'Run the pair validator both directions; use positive monotonic config versions, administrator/change-reference audit, validity and revocation metadata.', 'Verify the active host process receives the configs, opens the correct append-only trust ledger, and effective fingerprints/version match its latest ledger rows.', 'Verify rotation, revocation, version-gap/anti-rollback behavior from independent authority evidence; then separately validate external checkpoint continuity.'],
    prohibited: ['Do not mint or provision production keys in the candidate workspace.', 'Do not set a test-local key as production trust, change live environment/config, mutate the trust ledger, or assert an external anchor exists from local tests.', ...lifecycleProhibitions],
    verifyAfter: ['Fresh host health and trust status identify the host-owned RC candidate and both effective, version-pinned trust domains.', 'Pair validator passes against authority-issued public JSON and evidence of independent administration is retained.', 'Append-only ledger version/fingerprint state and separate externally signed monotonic anchor/continuity proof independently verify.'],
    evidence: [verifierMissingFinding?.sourceArtifact, reviewerMissingFinding?.sourceArtifact, ...inputArtifacts.filter(item => /preflight|dossier/.test(item.name))].filter(Boolean)
  }));

  const gateRemediation = (dossier.rc23Gates || []).map(gate => ({
    code: gate.code, ownerAuthority: gate.owner, missing: gate.missing, requiredVerification: gate.verify,
    prohibitedShortcut: gate.forbidden, evidence: gate.sourceArtifact || null, closed: false, closureAuthorityObserved: false
  }));
  const jobRecovery = recoveryRows.map(row => ({
    jobId: row.jobId, action: row.action,
    idempotencyKey: row.idempotencyKey, observedIdentity: row.observedIdentity,
    observedTaskLineage: taskRecords.filter(task => task.jobId === row.jobId).map(task => ({
      taskId: task.taskId, status: task.taskStatus, sourceShape: task.sourceShape,
      rowFingerprint: task.rowFingerprint, eventPayloadFingerprint: task.eventPayloadFingerprint,
      latestAttempt: task.latestAttempt, results: task.results, artifacts: task.artifacts, leases: task.leases,
      eventIds: task.eventIds, eventTypes: task.eventTypes, flags: task.flags,
      lineageAssessment: task.lineageAssessment, lifecycleEvidence: task.lifecycleEvidence, truncation: task.truncation,
      ownerAuthority: task.lineageAssessment?.ownerAuthority || task.lifecycleEvidence?.owner?.status || 'UNVERIFIED',
      providerAuthority: task.lineageAssessment?.providerIdentity || task.lifecycleEvidence?.provider?.status || 'UNVERIFIED',
      authorizationGranted: false
    })),
    sourceEvidence: inputArtifacts.find(item => item.name === 'lifecycleReconciliation') ||
      inputArtifacts.find(item => item.name === 'reconciliation') || null,
    preconditions: ['Re-query this exact job from a fresh read-only source before action.',
      'Verify current workflow owner, provider/run identity, runtime process/session, active attempt and lease/fencing epoch independently.',
      'Reconcile all referenced events, results and artifacts against the same job/task/attempt and current provider outcome.',
      'If any identity, fingerprint, authority or outcome is absent/contradictory, retain HOLD; absence of a lease is not a terminal disposition.'],
    postRepairVerification: ['Read back the resulting lifecycle state from a fresh connection and compare exact event/attempt/result/artifact lineage.',
      'Confirm an owner-authorized transition and authoritative provider/runtime outcome; this diagnostic plan cannot authorize the transition.'],
    nextAllowedAction: 'READ_ONLY_OWNER_PROVIDER_RUNTIME_RECONCILIATION',
    requiredAuthority: ['workflow owner', 'current provider/runtime operator', 'lease/fencing authority for any active task'],
    holdConditions: ['Owner or provider identity unresolved', 'Current process/run/lease/fencing state not independently observed',
      'Attempt/result/artifact/completion lineage does not identify the authoritative outcome'],
    prohibitedOperations: lifecycleProhibitions,
    authorizationGranted: false
  }));

  const blockers = [...new Set(gateBlockers.map(item => typeof item === 'string' ? item : item.code).filter(Boolean))];
  return {
    schemaVersion: 2,
    recordType: 'runalith-agg-live-remediation-plan',
    generatedAt,
    status: 'BLOCKED_NEEDS_OWNER_AUTHORITY_RECONCILIATION',
    decision: {
      canActivateNow: false, productionReady: false, lifecycleMutationAuthorized: false,
      liveWorkflowDatabaseMutationPerformed: false, externalTrustStoreMutationPerformed: false,
      productionConfigChanged: false, packageInstalledOrActivated: false,
      blockers
    },
    candidate: preflight?.candidate ? {
      path: preflight.candidate.path, version: preflight.candidate.version, sha256: preflight.candidate.sha256,
      archiveEntryCount: preflight.candidate.archiveEntryCount, toolCount: preflight.candidate.toolCount,
      entryPoint: preflight.candidate.entryPoint, candidateVerified: preflight.candidate.verified === true
    } : { path: dossier.candidate?.path || null, version: dossier.candidate?.version || null,
      sha256: dossier.candidate?.sha256 || null, archiveEntryCount: dossier.candidate?.archiveEntryCount || null,
      toolCount: dossier.candidate?.toolCount || null, entryPoint: dossier.candidate?.entryPoint || null,
      candidateVerified: false, note: 'No matching fresh preflight supplied; candidate identity is not asserted by this plan.' },
    sourceReports: inputArtifacts,
    observationWindow: {
      reconciliationGeneratedAt: reconciliation.generatedAt || null,
      lifecycleReconciliationGeneratedAt: lifecycle.generatedAt || null,
      dossierGeneratedAt: dossier.generatedAt || null,
      preflightGeneratedAt: preflight?.generatedAt || null,
      semantics: 'The timestamps are source-report capture times, not independent signatures. Re-query read-only live state before any owner-authorized remediation; this plan itself has no live access.'
    },
    currentFindings: {
      sourceHashMismatchCount: hashMismatches.length,
      sourceHashMismatchRecords: hashMismatches.map(item => {
        const enriched = dossierFindingsByRecord.get(`${item.code || ''}\0${item.recordId || ''}\0${item.detail || ''}`) || null;
        return { recordId: item.recordId || null, detail: item.detail || null,
          sourceArtifact: enriched?.sourceArtifact || item.sourceArtifact || null,
          confidence: enriched?.confidence || item.confidence || 'NOT_RECORDED_BY_SOURCE',
          cause: enriched?.cause || item.cause || 'Historical capture/mutation cause is not established by available evidence.',
          owner: enriched?.owner || item.owner || 'UNRESOLVED_NOT_RECORDED',
          provider: enriched?.provider || item.provider || 'UNRESOLVED_NOT_RECORDED',
          runtime: enriched?.runtime || item.runtime || 'UNRESOLVED_NOT_RECORDED',
          lease: enriched?.lease || item.lease || 'UNRESOLVED_NOT_RECORDED',
          allowedAction: enriched?.allowedAction || item.allowedAction || 'READ_ONLY_SOURCE_RECAPTURE_AFTER_OWNER_RECONCILIATION',
          prohibitedAction: enriched?.prohibitedAction || item.prohibitedAction || 'DO_NOT_REWRITE_HISTORICAL_EVIDENCE_OR_PROMOTE_UNVERIFIED_SOURCE',
          verifyAfter: enriched?.verifyAfter || item.verifyAfter || 'Fresh source and producer/result/attempt/event lineage must independently revalidate; preserve the historical record.' };
      }),
      goalEvidence: { goalId: targetGoalId, nodes: targetGoal?.nodeCount ?? null, edges: targetGoal?.edgeCount ?? null,
        memberships: targetGoal?.membershipCount ?? null, evidenceRefs: targetGoalEvidence?.declaredReferenceCount ?? null,
        attestationEligible: targetGoalEvidence?.eligibleForExternalAttestation ?? null,
        snapshotHash: targetGoal?.snapshotHash || dossier.liveState?.graph?.snapshotHash || null,
        observationStatus: targetGoal ? 'OBSERVED_IN_CURRENT_GRAPH_RECONCILIATION' : 'NOT_PRESENT_IN_GRAPH_RECONCILIATION',
        finding: goalEmptyEvidenceFinding || null },
      planGraph: { proposalCount: planProposals.length, totalStepCount: planProposals.reduce((sum, proposal) => sum + (proposal.readinessAssessment?.stepCount || proposal.planStepIds?.length || 0), 0),
        missingSupportingEvidenceStepCount: missingEvidenceSteps.length, missingEvidenceSteps,
        missingAuthenticatedSnapshotBindingCount: missingSnapshotBindings.length,
        proposalIds: planProposals.map(proposal => ({ jobId: proposal.jobId, eventId: proposal.eventId, sourceVerificationStatus: proposal.sourceVerificationStatus,
          snapshotBound: proposal.checks?.knowledgeSnapshotBound === true, signatureVerificationPerformed: proposal.checks?.signatureVerificationPerformed === true })) },
      executionGraph: { persistedProposalCount: executionProposals.length, sourceRecordScanComplete: Array.isArray(graph.proposalRecords),
        missingProposalFinding: executionMissingFinding || null },
      workflow: { consideredJobs: lifecycle.summary?.consideredJobs ?? lifecycle.diagnostics.length,
        executingJobs: executingJobs.length, runningTasks: runningTasks.length,
        runningTasksWithoutLease: runningTasks.filter(task => task.leases.length === 0).length,
        lifecycleSourceSchemaVersion: lifecycle.schemaVersion,
        staleCandidateIsProofOfWorkerDeath: false, missingLeaseAuthorizesTerminalization: false }
    },
    repairSteps: steps,
    workflowRecovery: {
      observationSource: inputArtifacts.find(item => item.name === 'lifecycleReconciliation') ||
        inputArtifacts.find(item => item.name === 'reconciliation') || null,
      jobs: jobRecovery,
      tasks: runningTasks.map(task => ({ ...task, sourceEvidence: { ...(inputArtifacts.find(item => item.name === 'lifecycleReconciliation') ||
          inputArtifacts.find(item => item.name === 'reconciliation') || {}),
          recordId: task.taskId, rowFingerprint: task.rowFingerprint || null, eventPayloadFingerprint: task.eventPayloadFingerprint || null,
          eventIds: task.eventIds, eventTypes: task.eventTypes, sourceShape: task.sourceShape },
        evidenceCompleteness: { rowFingerprintPresent: Boolean(task.rowFingerprint), eventPayloadFingerprintPresent: Boolean(task.eventPayloadFingerprint),
          eventIdsTruncated: task.truncation?.events === true, attemptsTruncated: task.truncation?.attempts === true,
          resultsTruncated: task.truncation?.results === true, artifactsTruncated: task.truncation?.artifacts === true,
          leasesTruncated: task.truncation?.leases === true, providerRunSchemaStatus: task.providerRunSchemaStatus,
          providerRunCount: task.providerRuns.length, nonterminalProviderRunCount: task.lineageAssessment?.nonterminalProviderRunIds?.length ?? null,
          providerRunTaskBinding: task.lineageAssessment?.providerRunTaskBinding || 'UNVERIFIED',
          providerRunLeaseMismatchIds: task.lineageAssessment?.providerRunLeaseMismatchIds || [],
          providerRunOwnerEpochMismatchIds: task.lineageAssessment?.providerRunOwnerEpochMismatchIds || [],
          ownerVerified: false, providerVerified: false,
          runtimeVerified: task.lifecycleEvidence?.runtime?.status === 'VERIFIED', leaseFencingVerified: false },
        action: 'HOLD_FOR_OWNER_RECONCILIATION', authorizationGranted: false,
        requiredAuthority: ['task owner/provider', 'current execution runtime operator', 'lease/fencing owner'],
        preconditions: ['Re-query the exact task and latest attempt from a fresh read-only source.',
          'Independently establish owner identity, provider request/run identity, runtime process/session and lease/fencing epoch.',
          'Resolve every referenced result, artifact and event to the same task/attempt; verify content hashes and terminal semantics.',
          'Unknown post-send outcomes, missing leases and missing process metadata remain HOLD/INDETERMINATE.'],
        permittedOperationsBeforeAuthority: allowedReadOnly, prohibitedOperations: lifecycleProhibitions,
        verifyAfter: ['Re-collect exact active attempt/run/lease/fencing identity and event/result/artifact lineage.',
          'Obtain an owner-authorized outcome decision and verify actual runtime status before any action.',
          'After any separately authorized transition, re-read durable state and authoritative provider/runtime state; confirm matching terminal evidence.'],
        postRepairVerification: ['Fresh-connection lifecycle readback matches the authorized transition.',
          'Provider/runtime terminal disposition and attempt/result/artifact/event lineage agree.',
          'No retry, replay, cancellation or terminalization is inferred from absent lease or telemetry.'].map((criterion, index) => ({
            id: `task-${task.taskId}-verify-${index + 1}`, criterion, required: true, mustUseFreshRead: true,
            independentlyVerified: false, mayCloseReleaseGateByItself: false
          })) }))
    },
    sixGateAssessment: gateRemediation,
    operationalContract: {
      thisPlanPerformsOnlyFileReadsAndWrites: true,
      workflowDbOpenedByThisScript: false,
      noAutomaticRepairOrRetry: true,
      missingLeaseIsNotDeathEvidence: true,
      historicalArtifactsMustRemainImmutable: true,
      testLocalTrustCannotCloseProductionGate: true,
      hostManagedActivationRequired: true
    }
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--dossier', '--reconciliation', '--lifecycle-reconciliation', '--preflight', '--output'].includes(key)) fail(`unsupported argument: ${key}`);
    if (args[key]) fail(`duplicate argument: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`missing value for ${key}`);
    args[key] = value;
  }
  for (const required of ['--dossier', '--reconciliation', '--output']) if (!args[required]) fail(`${required} is required`);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dossier = readRegularJson(args['--dossier'], 'readiness dossier');
  const reconciliation = readRegularJson(args['--reconciliation'], 'live reconciliation');
  const lifecycleReconciliation = args['--lifecycle-reconciliation']
    ? readRegularJson(args['--lifecycle-reconciliation'], 'lifecycle reconciliation') : null;
  if (!lifecycleReconciliation && reconciliation.value.schemaVersion === 1) {
    fail('--lifecycle-reconciliation is required with a schema-v1 graph report; schema v1 does not contain the complete lifecycle lineage inventory');
  }
  const preflight = args['--preflight'] ? readRegularJson(args['--preflight'], 'rollout preflight') : null;
  const sources = [inputArtifact('dossier', dossier), inputArtifact('reconciliation', reconciliation)];
  if (lifecycleReconciliation) sources.push(inputArtifact('lifecycleReconciliation', lifecycleReconciliation));
  if (preflight) sources.push(inputArtifact('preflight', preflight));

  if (preflight) {
    if (dossier.value.candidate?.sha256 !== preflight.value.candidate?.sha256 ||
        dossier.value.candidate?.version !== preflight.value.candidate?.version) {
      fail('dossier and preflight refer to different candidate version/digest');
    }
  }
  const expectedReconciliation = (dossier.value.evidenceInputs || []).find(item => item.name === 'reconciliation');
  if (expectedReconciliation && (path.resolve(expectedReconciliation.path) !== reconciliation.absolute ||
      expectedReconciliation.sha256 !== reconciliation.sha256)) {
    fail('dossier reconciliation evidence path/hash differs from the supplied reconciliation');
  }
  if (lifecycleReconciliation) {
    const graphDbPath = reconciliation.value.dbPath;
    const lifecycleDbPath = lifecycleReconciliation.value.dbPath;
    if (typeof graphDbPath !== 'string' || typeof lifecycleDbPath !== 'string' ||
        path.resolve(graphDbPath) !== path.resolve(lifecycleDbPath)) {
      fail('graph and lifecycle reconciliations must observe the same canonical workflow database path');
    }
  }
  const output = path.resolve(args['--output']);
  const outputParent = path.dirname(output);
  fs.mkdirSync(outputParent, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(outputParent) !== outputParent) fail('output parent must be canonical');
  const plan = buildAggLiveRemediationPlan({ dossier: dossier.value, reconciliation: reconciliation.value,
    lifecycleReconciliation: lifecycleReconciliation?.value || null,
    preflight: preflight?.value || null, inputArtifacts: sources });
  fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(output, 0o600);
  console.log(JSON.stringify({ status: plan.status, output, sha256: sha256(fs.readFileSync(output)),
    sourceHashMismatchCount: plan.currentFindings.sourceHashMismatchCount,
    missingEvidenceStepCount: plan.currentFindings.planGraph.missingSupportingEvidenceStepCount,
    missingSnapshotBindingCount: plan.currentFindings.planGraph.missingAuthenticatedSnapshotBindingCount,
    persistedExecutionGraphProposals: plan.currentFindings.executionGraph.persistedProposalCount,
    executingJobs: plan.currentFindings.workflow.executingJobs, runningTasks: plan.currentFindings.workflow.runningTasks,
    runningTasksWithoutLease: plan.currentFindings.workflow.runningTasksWithoutLease,
    blockers: plan.decision.blockers, mutationAuthorized: plan.decision.lifecycleMutationAuthorized }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`${error?.code || 'AGG_REMEDIATION_PLAN_FAILED'}: ${String(error?.message || error)}`);
    process.exitCode = 2;
  }
}
