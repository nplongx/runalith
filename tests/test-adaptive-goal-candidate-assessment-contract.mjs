import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { classifyCandidateEvidenceAssessment } from './helpers/adaptive-goal-candidate-assessment-contract.mjs';

const graphHash = 'b'.repeat(64);
const candidatePlanId = `agg-${'a'.repeat(24)}`;
const sourceReference = `file:src/runtime/example.js#sha256=${'c'.repeat(64)}`;
const tools = [{ name: 'adaptive_goal_graph_search' }];

function assessment(overrides = {}) {
  const base = {
    schemaVersion: 1,
    kind: 'adaptive_goal_candidate_evidence_resolution_assessment',
    status: 'resolver_observations_complete_claims_unverified',
    targetBinding: {
      graphHash, candidatePlanId, runtimeBundleSha256: null,
      runtimeBundleBinding: 'unavailable_at_mcp_runtime_boundary'
    },
    declaredReferenceCount: 1,
    sourceIntegrityVerifiedCount: 1,
    durableArtifactLineageVerifiedCount: 0,
    invalidProvenanceCount: 0,
    unresolvedReferenceCount: 0,
    sourceIntegrityCoverage: 1,
    durableArtifactLineageCoverage: 0,
    referenceResolutionCoverage: 1,
    claimVerifiedReferenceCount: 0,
    independentAttestationVerifiedReferenceCount: 0,
    claimCoverage: 0,
    independentAttestationCoverage: 0,
    candidateVerificationPreserved: true,
    candidateVerified: false,
    resolutions: [{
      reference: sourceReference, kind: 'source_file', status: 'source_integrity_only',
      classification: 'source_bytes_verified_claim_unverified', integrityVerified: true,
      expectedSha256: 'c'.repeat(64), observedSha256: 'c'.repeat(64),
      claimVerified: false, independenceVerified: false
    }],
    ...overrides
  };
  return { ...base, assessmentHash: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}

function result(value = {}) {
  return {
    status: 'proposals_found', graphHash,
    candidates: [{ planId: candidatePlanId, supportingEvidenceRefs: [sourceReference] }],
    candidateEvidenceAssessments: [assessment()],
    ...value
  };
}

test('distinguishes a missing search-tool capability from a missing response extension', () => {
  assert.equal(classifyCandidateEvidenceAssessment({ tools: [], result: {}, candidatePlanId, graphHash }).category,
    'tool_capability_missing');
  const missingExtension = result();
  delete missingExtension.candidateEvidenceAssessments;
  assert.equal(classifyCandidateEvidenceAssessment({ tools, result: missingExtension, candidatePlanId, graphHash }).category,
    'response_extension_missing');
});

test('rejects malformed assessment response schemas and mismatched graph/candidate bindings', () => {
  assert.equal(classifyCandidateEvidenceAssessment({ tools, result: result({ candidateEvidenceAssessments: {} }), candidatePlanId, graphHash }).category,
    'assessment_response_schema_invalid');
  const wrongBinding = assessment({ targetBinding: {
    graphHash: 'd'.repeat(64), candidatePlanId, runtimeBundleSha256: null,
    runtimeBundleBinding: 'unavailable_at_mcp_runtime_boundary'
  } });
  assert.equal(classifyCandidateEvidenceAssessment({ tools, result: result({ candidateEvidenceAssessments: [wrongBinding] }), candidatePlanId, graphHash }).category,
    'assessment_response_schema_invalid');
  assert.equal(classifyCandidateEvidenceAssessment({ tools, result: result(), candidatePlanId, graphHash: 'e'.repeat(64) }).category,
    'search_response_schema_invalid');
});

test('detects a modified assessment body when its hash is not recomputed', () => {
  const tampered = assessment();
  tampered.sourceIntegrityVerifiedCount = 0;
  assert.equal(classifyCandidateEvidenceAssessment({ tools, result: result({ candidateEvidenceAssessments: [tampered] }), candidatePlanId, graphHash }).category,
    'assessment_hash_mismatch');
});

test('rejects counters that contradict source observations even when the assessment hash is recomputed', () => {
  const inconsistent = assessment({ sourceIntegrityVerifiedCount: 0, sourceIntegrityCoverage: 0 });
  inconsistent.assessmentHash = createHash('sha256').update(JSON.stringify(Object.fromEntries(
    Object.entries(inconsistent).filter(([key]) => key !== 'assessmentHash')
  ))).digest('hex');
  assert.equal(classifyCandidateEvidenceAssessment({ tools,
    result: result({ candidateEvidenceAssessments: [inconsistent] }), candidatePlanId, graphHash }).category,
    'assessment_response_schema_invalid');
});

test('an assessment hash cannot elevate integrity into claim truth, independent review, or runtime authority', () => {
  const forged = assessment();
  forged.candidateVerified = true;
  forged.claimVerifiedReferenceCount = 1;
  forged.claimCoverage = 1;
  forged.independentAttestationVerifiedReferenceCount = 1;
  forged.independentAttestationCoverage = 1;
  forged.resolutions[0].claimVerified = true;
  forged.resolutions[0].independenceVerified = true;
  forged.targetBinding.runtimeBundleSha256 = 'd'.repeat(64);
  const { assessmentHash: _oldHash, ...hashBound } = forged;
  forged.assessmentHash = createHash('sha256').update(JSON.stringify(hashBound)).digest('hex');
  const classified = classifyCandidateEvidenceAssessment({ tools,
    result: result({ candidateEvidenceAssessments: [forged] }), candidatePlanId, graphHash });
  assert.equal(classified.category, 'assessment_response_schema_invalid',
    'recomputing a digest over attacker-controlled claims must not grant truth, independent review, or runtime binding');
  assert.equal(classified.schemaValid, false);
});

test('distinguishes valid integrity-only observations, unresolved evidence, and invalid provenance', () => {
  const healthy = classifyCandidateEvidenceAssessment({ tools, result: result(), candidatePlanId, graphHash });
  assert.equal(healthy.category, 'resolved_integrity_only_claims_unverified');
  assert.equal(healthy.schemaValid, true);
  assert.equal(healthy.assessment.candidateVerified, false);
  assert.equal(healthy.assessment.claimVerifiedReferenceCount, 0);

  const unresolvedBase = assessment({
    status: 'evidence_resolution_incomplete', sourceIntegrityVerifiedCount: 0, unresolvedReferenceCount: 1,
    sourceIntegrityCoverage: 0, referenceResolutionCoverage: 0,
    resolutions: [{ reference: sourceReference, kind: 'unresolved_reference', status: 'unresolved_reference',
      classification: 'unresolved_reference', resolverClassification: 'not_content_addressed',
      integrityVerified: false, lineageVerified: false, claimVerified: false, independenceVerified: false }]
  });
  const unresolved = classifyCandidateEvidenceAssessment({ tools,
    result: result({ candidateEvidenceAssessments: [unresolvedBase] }), candidatePlanId, graphHash });
  assert.equal(unresolved.category, 'evidence_unresolved');
  assert.equal(unresolved.schemaValid, true);

  const invalidBase = assessment({
    status: 'evidence_resolution_incomplete', sourceIntegrityVerifiedCount: 0, invalidProvenanceCount: 1,
    sourceIntegrityCoverage: 0, referenceResolutionCoverage: 0,
    resolutions: [{ reference: sourceReference, kind: 'source_file', status: 'source_hash_mismatch_or_stale',
      classification: 'source_hash_mismatch', integrityVerified: false, expectedSha256: 'c'.repeat(64),
      observedSha256: 'f'.repeat(64), claimVerified: false, independenceVerified: false }]
  });
  const invalid = classifyCandidateEvidenceAssessment({ tools,
    result: result({ candidateEvidenceAssessments: [invalidBase] }), candidatePlanId, graphHash });
  assert.equal(invalid.category, 'provenance_invalid');
  assert.equal(invalid.schemaValid, true);
});
