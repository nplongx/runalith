#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REQUIRED = Object.freeze(['--alignment', '--reconciliation', '--preflight', '--snapshot', '--trust-status', '--out']);
const RC23_GATES = Object.freeze([
  {
    code: 'PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED', owner: 'Phase 2 contract owner + platform security + controlled builder',
    missing: 'Owner-signed canonical 71-path manifest, candidate-bound builder receipt, and host-pinned authority policy at /etc/runalith/phase2-custody-trust.json.',
    action: 'Obtain the exact signed manifest and builder receipt from their authorities; run the Phase 2 custody verifier and read-only rollout preflight against the exact candidate.',
    verify: 'verifyPhase2CustodyEvidence reports CRYPTOGRAPHIC_AND_SOURCE_BINDINGS_VERIFIED; archive paths and bytes exactly equal the signed 71-path list and host policy pins the authority roots.',
    forbidden: 'Do not infer the path set from archive entry count or generate a local substitute manifest/receipt.'
  },
  {
    code: 'INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED', owner: 'Independent builder, independent verifier, release authority, host operator',
    missing: 'Trusted builder provenance, independent candidate verification, release approval, host-issued one-time nonce, and exact candidate/baseline/rollback bindings.',
    action: 'Run the controlled hosted build and independent verification workflow; preserve the signed outputs and release authority decision for the exact candidate digest.',
    verify: 'Release-evidence verifier accepts all signatures and bindings under host-pinned policy; preflight confirms productionReleaseEligible=true.',
    forbidden: 'Do not treat a local SHA-256, byte-alignment report, local build log, or isolated E2E as independent release evidence.'
  },
  {
    code: 'PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED', owner: 'Host/security administrator and the two independent trust authorities',
    missing: 'Both versioned JSON trust configs with authority-assigned provider IDs, valid Ed25519 public roots, exact scopes, audit metadata, and effective runtime ledger history.',
    action: 'Provision the exact authority-issued JSON through the host-supported configuration mechanism; validate the pair offline, inspect effective runtime configuration, and verify version/fingerprint ledger rows.',
    verify: 'Both domains are available in the active process; provider IDs differ, canonical SPKI roots are disjoint, config versions/fingerprints match append-only runtime ledger history, and rotation/revocation/anti-rollback checks pass.',
    forbidden: 'Do not create keys or config values locally, accept blank/placeholder interpolation, or treat vacuous root-separation booleans as configured trust.'
  },
  {
    code: 'PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED', owner: 'Host/security authority and independently operated checkpoint-store authority',
    missing: 'Host-owned root-pinned policy, protected adapter identity, separate authority/store-attestation roots, independently protected monotonic store, and fresh signed continuity/CAS receipts.',
    action: 'Provision the adapter and policy outside the plugin tree; independently verify ownership, permissions, executable hash, root separation, external continuity, nonce consumption and compare-and-swap semantics.',
    verify: 'Read-only preflight validates fresh signed checkpoint continuity bound to exact candidate and rollback; the independent store demonstrates monotonicity across restart/restore boundaries.',
    forbidden: 'Do not invoke --advance-external-checkpoint as a diagnostic or until separately authorized after all other gates pass.'
  },
  {
    code: 'ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN', owner: 'Each workflow owner plus its provider/runtime operator',
    missing: 'Per-job authoritative owner/provider/runtime disposition linked to events, attempts, results, artifacts, active-task pointer and lease fencing.',
    action: 'Reconcile each listed job individually using authoritative host/provider records; preserve unresolved records and document the approved lifecycle path before any transition.',
    verify: 'Fresh read-only reconciliation shows no unresolved executing jobs and each prior job has matching authoritative outcome/completion lineage.',
    forbidden: 'Do not bulk-reset, terminalize, cancel, retry, kill, or dispatch from stale age or missing-lease evidence.'
  },
  {
    code: 'RUNNING_TASKS_MUST_DRAIN', owner: 'Each task owner plus provider/runtime and lease authority',
    missing: 'Authoritative process/provider run identity and matching attempt/result/artifact/completion evidence for every running task.',
    action: 'Resolve every task with owner/provider confirmation and durable lineage; retain HOLD when process identity or remote outcome is unavailable.',
    verify: 'Fresh reconciliation shows zero unresolved running tasks; every resolved task has consistent attempt/result/artifact/completion and lease history.',
    forbidden: 'Do not infer worker death from an absent PID, provider ID, or lease row; do not replay uncertain remote effects.'
  }
]);

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readJson(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be a canonical regular non-symlink file`);
  }
  const bytes = fs.readFileSync(resolved);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${label} is not valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return { path: resolved, sha256: sha256(bytes), value };
}
function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is missing or invalid`);
  return value;
}
function firstDefined(...values) { return values.find(value => value !== undefined && value !== null) ?? null; }

export function buildAggReadinessDossier({ alignment, reconciliation, preflight, snapshot, trustStatus, generatedAt = new Date().toISOString() }) {
  for (const [value, label] of [[alignment, 'alignment'], [reconciliation, 'reconciliation'], [preflight, 'preflight'], [snapshot, 'snapshot'], [trustStatus, 'trust status']]) requireRecord(value, label);
  if (alignment.status !== 'PASS_SOURCE_TO_BUNDLE_BYTE_ALIGNMENT' || alignment.byteIdentityStatus !== 'PASS_EXACT_ARCHIVE_ENTRY_BYTES') {
    throw new Error('source-to-bundle alignment must pass exact archive entry byte identity');
  }
  if (reconciliation.readOnly !== true || preflight.readOnly !== true || preflight.liveMutationPerformed !== false ||
      preflight.workflowDatabaseMutationPerformed !== false || preflight.externalSecurityStoreMutationPerformed !== false) {
    throw new Error('dossier inputs must prove read-only reconciliation and preflight with no live/external mutation');
  }
  if (preflight.candidate?.sha256 !== alignment.bundleSha256) throw new Error('candidate SHA-256 differs between alignment and rollout preflight');
  if (snapshot.goal_id !== 'runalith-agg-e2e-20261026-clean' || snapshot.snapshot?.snapshot_hash !== reconciliation.adaptiveGoalGraph?.goals?.find(g => g.goalId === snapshot.goal_id)?.snapshotHash) {
    throw new Error('dedicated live Goal/Idea snapshot does not match the current reconciliation report');
  }
  if (snapshot.verified !== false || snapshot.eligibleForAttestation !== false || snapshot.evidenceManifest?.length !== 0) {
    throw new Error('snapshot must retain its observed unverified/evidence-ineligible state; this tool cannot promote it');
  }
  const agg = reconciliation.adaptiveGoalGraph || {};
  const summary = reconciliation.summary || {};
  const proposalSummary = agg.proposalSummary || {};
  const liveGoal = (agg.goals || []).find(g => g.goalId === snapshot.goal_id) || null;
  const sourceMismatchFindings = (agg.findings || []).filter(f => f.detail === 'source_hash_mismatch').map(f => ({
    code: f.code,
    recordType: f.recordType || 'planner_evidence',
    recordId: f.recordId,
    detail: f.detail,
    confidence: 'CONFIRMED_BY_CURRENT_READ_ONLY_REVALIDATION',
    cause: 'Current source bytes do not match the historical planner evidence digest; the exact historical mutation/capture cause is not established by this finding.',
    owner: 'Repository/source artifact owner; identity not recorded in this planner evidence finding',
    provider: 'Not applicable or not persisted in this finding',
    runtime: 'Current repository-bound source revalidation; no runtime execution claim',
    lease: 'Not applicable',
    allowedAction: 'Preserve historical record; inspect the referenced run/evidence and capture a fresh content-addressed source artifact under the normal producer contract.',
    prohibitedAction: 'Do not rewrite historical digests or promote the stale source record to verified.',
    verifyAfter: 'Fresh planner evidence resolves to exact current bytes and durable producer/result/attempt/completion lineage; old finding remains in immutable history.'
  }));
  const runningTasks = (reconciliation.diagnostics || []).flatMap(job => (job.tasks || []).filter(t => String(t.task?.status).toLowerCase() === 'running').map(t => ({ job, taskEntry: t })));
  const executingJobs = (reconciliation.diagnostics || []).filter(job => String(job.state).toUpperCase() === 'EXECUTING');
  const workflowRecovery = executingJobs.map(job => ({
    jobId: job.jobId, state: job.state, status: job.status, phase: job.phase, updatedAt: job.updatedAt,
    activeTaskId: job.activeTaskId, ownerAuthority: job.ownerBinding?.authority || 'unresolved',
    ownerBinding: job.ownerBinding || null,
    providerIdentity: firstDefined(job.runtimeObservation?.providerRunIdentity, job.runtimeObservation?.providerIdentity,
      job.ownerBinding?.providerId, 'unavailable'),
    providerWaiting: job.providerWaiting ?? null, providerRetryAt: job.providerRetryAt ?? null,
    runtimeObservation: job.runtimeObservation || null, activeLeaseCount: job.activeLeaseCount ?? null,
    taskCounts: job.taskCounts || null, latestApproval: job.latestApproval || null,
    jobFlags: job.flags || [], jobFindings: job.findings || [], ownerAction: job.ownerAction || null,
    runningTasks: (job.tasks || []).filter(t => String(t.task?.status).toLowerCase() === 'running').map(t => ({
      taskId: t.task?.taskId, status: t.task?.status, attemptId: t.latestAttempt?.attemptId || null,
      providerRunId: t.latestAttempt?.runId || null, resultIds: (t.recentResults || []).map(r => r.resultId),
      artifactIds: (t.recentArtifacts || []).map(a => a.artifactId), leaseIds: (t.leases || []).map(l => l.leaseId),
      flags: t.flags || [], ownerAuthority: t.lineageAssessment?.ownerAuthority || 'unresolved',
      providerBinding: t.lineageAssessment?.providerRunIdentityBinding || 'unavailable'
    })),
    attemptIds: [...new Set((job.tasks || []).flatMap(t => (t.attempts || []).map(a => a.attemptId).filter(Boolean)))],
    resultIds: [...new Set((job.tasks || []).flatMap(t => (t.recentResults || []).map(r => r.resultId).filter(Boolean)))],
    artifactIds: [...new Set((job.tasks || []).flatMap(t => (t.recentArtifacts || []).map(a => a.artifactId).filter(Boolean)))],
    leaseIds: [...new Set((job.tasks || []).flatMap(t => (t.leases || []).map(l => l.leaseId).filter(Boolean)))],
    eventIds: job.allJobEventIds || [], classification: job.classification,
    action: 'HOLD_FOR_OWNER_RECONCILIATION', authorizationGranted: false,
    verifyAfter: 'Re-read exact job/task/attempt/result/artifact/event/lease records and provider state; rerun read-only reconciliation after an owner-authorized lifecycle decision.'
  }));
  const blockers = new Set(preflight.decision?.blockers || []);
  const gates = RC23_GATES.map(gate => ({
    ...gate,
    status: blockers.has(gate.code) ? 'OPEN' : 'NOT_CLOSED_BY_THIS_EVIDENCE',
    evidence: blockers.has(gate.code) ? 'Current rollout preflight explicitly reports this blocker.' : 'Absence from the blocker list is not sufficient authority to close this gate; independent closure evidence was not supplied to this dossier.',
    authorizationGranted: false
  }));
  const domains = trustStatus.domains || {};
  const trustDomainState = Object.fromEntries(['goal_idea_verifier', 'action_intent_reviewer'].map(domain => {
    const item = domains[domain] || {};
    return [domain, { available: item.available === true, providerIdPresent: Boolean(item.providerId), rootCount: Array.isArray(item.roots) ? item.roots.length : 0,
      configurationFingerprintPresent: Boolean(item.configurationFingerprint), blockers: item.blockers || [],
      effectiveTrustVerified: item.available === true && Boolean(item.providerId) && Array.isArray(item.roots) && item.roots.length > 0 && Boolean(item.configurationFingerprint) }];
  }));
  const additionalBlockers = (preflight.decision?.blockers || []).filter(code => !RC23_GATES.some(gate => gate.code === code));
  const evidenceInputs = [alignment, reconciliation, preflight, snapshot, trustStatus].map(item => ({
    path: item.__path || null, sha256: item.__sha256 || null, source: item.__source || 'caller-supplied-current-observation'
  }));
  const liveState = {
    observedAt: reconciliation.generatedAt || null,
    tableCounts: reconciliation.tableCounts || {},
    jobs: { ...summary, executingJobs: executingJobs.length, runningTasks: runningTasks.length,
      runningTasksWithoutActiveLease: runningTasks.filter(({ taskEntry }) => !(taskEntry.leases || []).some(lease => String(lease.state).toUpperCase() === 'ACTIVE')).length },
    graph: {
      goalId: snapshot.goal_id, snapshotHash: snapshot.snapshot.snapshot_hash, nodeCount: snapshot.snapshot.nodes?.length || 0,
      edgeCount: snapshot.snapshot.edges?.length || 0, membershipCount: snapshot.snapshot.memberships?.length || 0,
      evidenceReferenceCount: snapshot.snapshot.evidence_refs?.length || 0, evidenceManifestCount: snapshot.evidenceManifest?.length || 0,
      evidenceManifestHash: snapshot.evidenceManifestHash, integrityValid: snapshot.snapshot.integrity_valid === true,
      verified: snapshot.verified === true, eligibleForAttestation: snapshot.eligibleForAttestation === true,
      attestationBlockers: snapshot.attestationBlockers || []
    },
    planner: agg.plannerSummary || {},
    sourceHashMismatchCount: sourceMismatchFindings.length,
    planGraph: { proposals: proposalSummary.planGraphProposals || 0, steps: proposalSummary.planGraphSteps || proposalSummary.planGraphStepsObserved || 0,
      stepsMissingSupportingEvidence: proposalSummary.planGraphStepsMissingEvidence || 0,
      proposalsWithoutAuthenticatedSnapshotBinding: proposalSummary.planGraphProposalsWithoutAuthenticatedSnapshotBinding || 0,
      proposalsWithUnverifiedSource: proposalSummary.planGraphProposalsWithUnverifiedSource || 0 },
    executionGraph: { persistedProposals: proposalSummary.executionGraphProposals || 0,
      executionPlanCandidateEvents: proposalSummary.executionPlanCandidateEvents || 0 },
    trustDomains: trustDomainState,
    externalAnchor: preflight.host?.trustConfiguration?.externalAntiRollbackAnchor || null
  };
  const candidate = {
    version: preflight.candidate?.version || null, path: preflight.candidate?.path || alignment.bundlePath,
    sha256: preflight.candidate?.sha256 || alignment.bundleSha256, sizeBytes: preflight.candidate?.sizeBytes || alignment.bundleBytes,
    archiveEntryCount: alignment.archiveEntryCount, toolCount: alignment.manifestToolCount,
    entryPoint: preflight.candidate?.entryPoint || preflight.candidate?.manifest?.server?.entry_point || null,
    sourceSnapshotSha256: alignment.sourceSnapshotSha256, sourceProvenanceStatus: alignment.sourceProvenanceStatus,
    releaseEligibility: alignment.releaseEligibility, archiveByteAlignment: alignment.byteIdentityStatus,
    installedRuntime: preflight.host?.installedGeneration || null
  };
  const findings = [
    ...sourceMismatchFindings,
    {
      code: 'KNOWLEDGE_EVIDENCE_MANIFEST_EMPTY', confidence: 'CONFIRMED_BY_DEDICATED_LIVE_SNAPSHOT_AND_RECONCILIATION',
      source: 'live Goal/Idea snapshot + read-only reconciliation', goalId: snapshot.goal_id, snapshotHash: snapshot.snapshot.snapshot_hash,
      cause: 'All seven current node revisions have empty evidenceRefs; the canonical evidence manifest has zero entries.',
      owner: 'Goal/Idea evidence producers and the source artifact owner; no independent claim verifier is currently configured.',
      provider: 'No trusted verifier provider is configured', runtime: 'Active Runalith RC.26 host process', lease: 'Not applicable to the graph snapshot',
      allowedAction: 'Produce real typed artifacts through the authorized producer path, then reference only durable artifact:// records whose hash and producer/result/attempt/completion lineage revalidate.',
      prohibitedAction: 'Do not add placeholder evidenceRefs, use isolated test artifacts as production evidence, or revise the graph to claim verification.',
      verifyAfter: 'A fresh snapshot shows non-empty verified durable evidence manifest, current exact snapshot binding, independent signed attestation, and successful revalidation.'
    },
    {
      code: 'KNOWLEDGE_VERIFIER_NOT_CONFIGURED', confidence: 'CONFIRMED_BY_RUNTIME_SNAPSHOT_AND_TRUST_STATUS',
      source: 'adaptive_goal_knowledge_snapshot_get + adaptive_goal_trust_configuration_status',
      cause: 'AGG_KNOWLEDGE_VERIFICATION_TRUST_CONFIG_JSON is blank in the effective runtime.', owner: 'Host/security administrator + independent Goal/Idea verifier authority',
      provider: 'Not configured', runtime: 'Effective process environment reports unavailable', lease: 'Not applicable',
      allowedAction: 'Provision the authority-issued versioned config through host-supported configuration and verify effective runtime ledger state.',
      prohibitedAction: 'Do not inject a locally generated key, test identity, MCP argument, or shell-only variable.',
      verifyAfter: 'Runtime status reports available with provider/root fingerprints and matching versioned trust-ledger history.'
    },
    {
      code: 'AGG_TRUST_CONFIG_NOT_CONFIGURED', confidence: 'CONFIRMED_BY_RUNTIME_TRUST_STATUS',
      source: 'adaptive_goal_trust_configuration_status', cause: 'AGG_REVIEW_IDENTITY_TRUST_CONFIG_JSON is blank in the effective runtime.',
      owner: 'Host/security administrator + independent action-intent reviewer authority', provider: 'Not configured', runtime: 'Effective process environment reports unavailable', lease: 'Not applicable',
      allowedAction: 'Provision the independently administered reviewer config with exact action-intent scope, then verify runtime version/fingerprint ledger history.',
      prohibitedAction: 'Do not substitute the Goal/Idea verifier key or any isolated test identity.',
      verifyAfter: 'Runtime status reports reviewer domain available with distinct provider ID and disjoint canonical SPKI roots.'
    },
    {
      code: 'PLAN_GRAPH_SUPPORTING_EVIDENCE_MISSING', confidence: 'CONFIRMED_BY_CURRENT_READ_ONLY_RECONCILIATION',
      source: 'adaptiveGoalGraph.proposalSummary', cause: `${proposalSummary.planGraphStepsMissingEvidence || 0} observed Plan Graph steps lack validated supporting evidence.`,
      owner: 'Artifact producers for each bound task and the Plan Graph reviewer', provider: 'Per-job provider identity is not persisted for these historical proposals', runtime: 'Historical proposal event lineage only', lease: 'Not applicable to proposal records',
      allowedAction: 'Re-run the authorized producers only after trust and source snapshot gates pass; map each step to active durable artifacts with verified lineage.',
      prohibitedAction: 'Do not copy isolated E2E artifacts or mark declared references as verified.',
      verifyAfter: 'Readiness check validates supporting evidence for every step and binds the proposal to the authenticated current snapshot.'
    },
    {
      code: 'EXECUTION_GRAPH_PROPOSALS_NOT_PERSISTED', confidence: 'CONFIRMED_BY_CURRENT_READ_ONLY_RECONCILIATION',
      source: 'adaptiveGoalGraph.proposalSummary', cause: 'No persisted Execution Graph proposal or execution-plan-candidate event is present in the current proposal inventory.',
      owner: 'Plan Graph owner/reviewer after upstream evidence and trust gates pass', provider: 'Not applicable until a valid persisted plan exists', runtime: 'Current live proposal event inventory', lease: 'Not applicable',
      allowedAction: 'After evidence, snapshot attestation, plan pinning, and reviewer approval are valid, create and read back a new Execution Graph proposal.',
      prohibitedAction: 'Do not persist or dispatch an Execution Graph from caller-supplied or isolated test graph data.',
      verifyAfter: 'Execution Graph proposal readback validates exact source Plan Graph hash, supporting evidence, authenticated snapshot binding, approval and fail-closed dispatch lifecycle.'
    }
  ];
  return {
    schemaVersion: 1, recordType: 'runalith-agg-live-readiness-dossier', generatedAt,
    decision: { status: 'BLOCKED', canActivateNow: false, productionReady: false,
      reason: 'Current evidence confirms source/archive byte identity but does not establish independent release authority, production trust, external checkpoint continuity, graph evidence eligibility, or live workflow/task drain.',
      activationAuthorized: false, lifecycleMutationAuthorized: false },
    candidate, evidenceInputs,
    checks: {
      sourceToBundleByteAlignment: 'PASS', sourceProvenanceAuthenticated: false,
      mcpbArchiveIntegrity: preflight.candidate?.smoke?.passed === true ? 'PASS_IN_PREFLIGHT' : 'NOT_PROVEN',
      runtimeToolCount: alignment.manifestToolCount, expectedToolCount: 74,
      isolatedE2EIsProductionEvidence: false, productionTrustEstablished: false,
      liveDatabaseMutated: false, hostRegistryMutated: false, pluginInstalledOrRestarted: false
    },
    liveState, findings, workflowRecovery,
    rc23Gates: gates,
    additionalBlockers: additionalBlockers.map(code => ({ code, status: 'OPEN', source: 'current rollout preflight',
      action: code === 'ROLLBACK_BUNDLE_NOT_VERIFIED' || code === 'ROLLBACK_VERSION_DOES_NOT_MATCH_INSTALLED_BASELINE'
        ? 'Use a verified rollback archive whose version and bytes match the installed baseline; do not claim RC.25 is the current rollback baseline while RC.26 is installed.'
        : code === 'CANDIDATE_VERSION_ALREADY_INSTALLED'
          ? 'Treat RC.26 as the installed baseline, not as a new activation candidate; evaluate a separately versioned successor only through host-managed rollout.'
          : 'Inspect the exact preflight detail and resolve only through the owner-authorized path.', authorizationGranted: false })),
    policy: { evidenceIsReadOnlyObservation: true, reportHashIsIntegrityNotAuthority: true,
      noTestTrustPromotedToProduction: true, noMissingLeaseMeansWorkerDead: true,
      missingOrUnreportedGateNeverAutomaticallyCloses: true, lifecycleActionsAreNotAuthorized: true }
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!REQUIRED.includes(flag)) throw new Error(`unsupported argument: ${flag}`);
    if (out[flag]) throw new Error(`${flag} may be supplied only once`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
    out[flag] = value;
  }
  for (const flag of REQUIRED) if (!out[flag]) throw new Error(`${flag} is required`);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = Object.fromEntries([
    ['alignment', '--alignment'], ['reconciliation', '--reconciliation'], ['preflight', '--preflight'],
    ['snapshot', '--snapshot'], ['trustStatus', '--trust-status']
  ].map(([key, flag]) => [key, readJson(args[flag], flag)]));
  const dossier = buildAggReadinessDossier(Object.fromEntries(Object.entries(loaded).map(([key, item]) => [key, {
    ...item.value, __path: item.path, __sha256: item.sha256, __source: key
  }])));
  dossier.evidenceInputs = Object.entries(loaded).map(([key, item]) => ({ name: key, path: item.path, sha256: item.sha256,
    semanticAuthority: key === 'alignment' ? 'local byte identity only' : key === 'reconciliation' ? 'read-only local DB inspection' :
      key === 'preflight' ? 'read-only rollout gate evaluation' : key === 'snapshot' ? 'live runtime graph observation' : 'live runtime trust status observation' }));
  const outputPath = path.resolve(args['--out']);
  if (fs.existsSync(outputPath) || fs.existsSync(outputPath) && fs.lstatSync(outputPath).isSymbolicLink()) throw new Error('refusing to overwrite an existing dossier');
  if (fs.realpathSync(path.dirname(outputPath)) !== path.dirname(outputPath)) throw new Error('output parent must be a canonical directory');
  const fd = fs.openSync(outputPath, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(dossier, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  process.stdout.write(`AGG_READINESS_DOSSIER=${dossier.decision.status} candidate_sha256=${dossier.candidate.sha256} rc23_open=${dossier.rc23Gates.filter(g => g.status === 'OPEN').length} findings=${dossier.findings.length} report=${outputPath} sha256=${sha256(fs.readFileSync(outputPath))}\n`);
  process.exitCode = dossier.decision.status === 'BLOCKED' ? 3 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`AGG_READINESS_DOSSIER_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
