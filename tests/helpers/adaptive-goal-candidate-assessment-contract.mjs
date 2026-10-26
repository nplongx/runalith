import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const ASSESSMENT_KEYS = [
  'assessmentHash', 'candidateVerificationPreserved', 'candidateVerified', 'claimCoverage',
  'claimVerifiedReferenceCount', 'declaredReferenceCount', 'durableArtifactLineageCoverage',
  'durableArtifactLineageVerifiedCount', 'independentAttestationCoverage',
  'independentAttestationVerifiedReferenceCount', 'invalidProvenanceCount', 'kind',
  'referenceResolutionCoverage', 'resolutions', 'schemaVersion', 'sourceIntegrityCoverage',
  'sourceIntegrityVerifiedCount', 'status', 'targetBinding', 'unresolvedReferenceCount'
].sort();

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function ratio(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function fail(category, detail) {
  return { category, schemaValid: false, detail };
}

/**
 * Distinguish the tool capability from the response extension and the evidence
 * disposition. It is deliberately test-side: it never upgrades runtime authority.
 */
export function classifyCandidateEvidenceAssessment({ tools, result, candidatePlanId, graphHash }) {
  if (!Array.isArray(tools) || !tools.some(tool => tool?.name === 'adaptive_goal_graph_search')) {
    return fail('tool_capability_missing', 'tools/list does not expose adaptive_goal_graph_search');
  }
  if (!isRecord(result) || !SHA256.test(result.graphHash || '') || result.graphHash !== graphHash ||
      !['proposals_found', 'budget_exhausted', 'max_depth_reached'].includes(result.status) ||
      !Array.isArray(result.candidates) ||
      result.candidates.filter(candidate => candidate?.planId === candidatePlanId).length !== 1) {
    return fail('search_response_schema_invalid', 'search status, graph binding, or exact candidate is invalid');
  }
  if (!Object.hasOwn(result, 'candidateEvidenceAssessments')) {
    return fail('response_extension_missing', 'search RPC succeeded but response omitted candidateEvidenceAssessments');
  }
  if (!Array.isArray(result.candidateEvidenceAssessments)) {
    return fail('assessment_response_schema_invalid', 'candidateEvidenceAssessments must be an array');
  }
  const matches = result.candidateEvidenceAssessments.filter(item => item?.targetBinding?.candidatePlanId === candidatePlanId);
  if (matches.length !== 1) {
    return fail('assessment_response_schema_invalid', 'assessment must bind exactly one entry to the exact candidate');
  }
  const assessment = matches[0];
  if (!isRecord(assessment) || Object.keys(assessment).sort().join(',') !== ASSESSMENT_KEYS.join(',') ||
      assessment.schemaVersion !== 1 || assessment.kind !== 'adaptive_goal_candidate_evidence_resolution_assessment' ||
      !['evidence_resolution_incomplete', 'resolver_observations_complete_claims_unverified'].includes(assessment.status) ||
      !isRecord(assessment.targetBinding) || assessment.targetBinding.graphHash !== graphHash ||
      Object.keys(assessment.targetBinding).sort().join(',') !==
        ['candidatePlanId', 'graphHash', 'runtimeBundleBinding', 'runtimeBundleSha256'].sort().join(',') ||
      assessment.targetBinding.candidatePlanId !== candidatePlanId || assessment.targetBinding.runtimeBundleSha256 !== null ||
      assessment.targetBinding.runtimeBundleBinding !== 'unavailable_at_mcp_runtime_boundary' ||
      !SHA256.test(assessment.assessmentHash || '') ||
      !['declaredReferenceCount', 'sourceIntegrityVerifiedCount', 'durableArtifactLineageVerifiedCount',
        'invalidProvenanceCount', 'unresolvedReferenceCount', 'claimVerifiedReferenceCount',
        'independentAttestationVerifiedReferenceCount'].every(key => Number.isSafeInteger(assessment[key]) && assessment[key] >= 0) ||
      !['sourceIntegrityCoverage', 'durableArtifactLineageCoverage', 'referenceResolutionCoverage', 'claimCoverage',
        'independentAttestationCoverage'].every(key => ratio(assessment[key])) ||
      assessment.candidateVerificationPreserved !== true || assessment.candidateVerified !== false ||
      assessment.claimVerifiedReferenceCount !== 0 || assessment.independentAttestationVerifiedReferenceCount !== 0 ||
      assessment.claimCoverage !== (assessment.declaredReferenceCount ? 0 : null) ||
      assessment.independentAttestationCoverage !== (assessment.declaredReferenceCount ? 0 : null) ||
      !Array.isArray(assessment.resolutions) || assessment.resolutions.length !== assessment.declaredReferenceCount) {
    return fail('assessment_response_schema_invalid', 'assessment fields violate the version-1 closed response contract');
  }

  const candidate = result.candidates.find(item => item.planId === candidatePlanId);
  if (!Array.isArray(candidate.supportingEvidenceRefs)) {
    return fail('assessment_response_schema_invalid', 'candidate supporting references must be an array');
  }
  const expectedReferences = [...new Set(candidate.supportingEvidenceRefs)].sort();
  if (expectedReferences.length !== candidate.supportingEvidenceRefs.length ||
      assessment.declaredReferenceCount !== expectedReferences.length ||
      assessment.resolutions.some((item, index) => !isRecord(item) || item.reference !== expectedReferences[index] ||
        item.claimVerified !== false || item.independenceVerified !== false)) {
    return fail('assessment_response_schema_invalid', 'assessment resolutions are not a unique, exact binding of candidate references');
  }

  const { assessmentHash, ...hashBound } = assessment;
  if (hash(JSON.stringify(hashBound)) !== assessmentHash) {
    return fail('assessment_hash_mismatch', 'assessmentHash does not bind the returned assessment bytes');
  }

  const countSourceIntegrity = assessment.resolutions.filter(item => item.kind === 'source_file' &&
    item.status === 'source_integrity_only' && item.integrityVerified === true).length;
  const countDurableLineage = assessment.resolutions.filter(item => item.kind === 'durable_artifact' &&
    item.status === 'durable_artifact_lineage_verified_claim_unverified' && item.lineageVerified === true).length;
  const countInvalid = assessment.resolutions.filter(item =>
    item.kind === 'source_file'
      ? !(item.status === 'source_integrity_only' && item.integrityVerified === true)
      : item.kind === 'durable_artifact'
        ? !(item.status === 'durable_artifact_lineage_verified_claim_unverified' && item.lineageVerified === true)
        : false).length;
  const countUnresolved = assessment.resolutions.filter(item => !['source_file', 'durable_artifact'].includes(item.kind)).length;
  const coverage = count => assessment.declaredReferenceCount
    ? Number((count / assessment.declaredReferenceCount).toFixed(6)) : null;
  if (assessment.sourceIntegrityVerifiedCount !== countSourceIntegrity ||
      assessment.durableArtifactLineageVerifiedCount !== countDurableLineage ||
      assessment.invalidProvenanceCount !== countInvalid || assessment.unresolvedReferenceCount !== countUnresolved ||
      assessment.sourceIntegrityCoverage !== coverage(countSourceIntegrity) ||
      assessment.durableArtifactLineageCoverage !== coverage(countDurableLineage) ||
      assessment.referenceResolutionCoverage !== coverage(countSourceIntegrity + countDurableLineage)) {
    return fail('assessment_response_schema_invalid', 'assessment aggregate counts/coverage disagree with per-reference resolver observations');
  }
  if ((assessment.invalidProvenanceCount > 0 || assessment.unresolvedReferenceCount > 0) !==
      (assessment.status === 'evidence_resolution_incomplete')) {
    return fail('assessment_response_schema_invalid', 'assessment status contradicts its unresolved/invalid reference counts');
  }

  const common = { schemaValid: true, assessment };
  if (assessment.invalidProvenanceCount > 0) return { ...common, category: 'provenance_invalid' };
  if (assessment.unresolvedReferenceCount > 0) return { ...common, category: 'evidence_unresolved' };
  return { ...common, category: 'resolved_integrity_only_claims_unverified' };
}
