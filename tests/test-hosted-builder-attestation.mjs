import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RUNALITH_EXPECTED_BUILDER_ID, RUNALITH_GITHUB_ACTIONS_BUILD_TYPE, RUNALITH_HOSTED_BUILD_OIDC_ISSUER,
  RUNALITH_HOSTED_BUILD_REPOSITORY, RUNALITH_HOSTED_BUILD_WORKFLOW,
  RUNALITH_SLSA_PREDICATE, validateHostedBuilderVerificationOutput, verifyHostedBuilderAttestation
} from '../scripts/lib/hosted-builder-attestation.mjs';

const commit = '1'.repeat(40);
const bytes = Buffer.from('MCPB archive content; tests do not represent an actual Runalith release.');
const candidateSha256 = createHash('sha256').update(bytes).digest('hex');
const VERIFIED_AT = new Date().toISOString();

function verificationOutput({ digest = candidateSha256, sourceCommit = commit,
  repositoryUrl = `https://github.com/${RUNALITH_HOSTED_BUILD_REPOSITORY}`, predicateType = RUNALITH_SLSA_PREDICATE,
  buildType = RUNALITH_GITHUB_ACTIONS_BUILD_TYPE, builderId = RUNALITH_EXPECTED_BUILDER_ID,
  timestampCount = 1, subjectCount = 1 } = {}) {
  const subject = { name: 'runalith-1.0.9-rc.11-candidate.mcpb', digest: { sha256: digest } };
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: Array.from({ length: subjectCount }, () => ({ ...subject })),
    predicateType,
    predicate: {
      buildDefinition: {
        buildType,
        externalParameters: { workflow: { repository: repositoryUrl, ref: 'refs/heads/main', path: RUNALITH_HOSTED_BUILD_WORKFLOW } },
        resolvedDependencies: [{ uri: `git+https://github.com/${RUNALITH_HOSTED_BUILD_REPOSITORY}@refs/heads/main`, digest: { gitCommit: sourceCommit } }]
      },
      runDetails: { builder: { id: builderId }, metadata: { invocationId: 'test-run-123' } }
    }
  };
  return [{
    attestation: { bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' } },
    verificationResult: {
      statement,
      signature: { certificate: { issuer: RUNALITH_HOSTED_BUILD_OIDC_ISSUER } },
      verifiedTimestamps: Array.from({ length: timestampCount }, () => ({ type: 'Tlog', timestamp: VERIFIED_AT }))
    }
  }];
}

test('accepts exactly one verified SLSA statement bound to candidate, GitHub repository and immutable source commit', () => {
  const result = validateHostedBuilderVerificationOutput(verificationOutput(), {
    candidateSha256, sourceCommit: commit
  });
  assert.equal(result.status, 'HOSTED_BUILDER_PROVENANCE_VERIFIED');
  assert.equal(result.candidateSha256, candidateSha256);
  assert.equal(result.sourceCommit, commit);
  assert.equal(result.repository, RUNALITH_HOSTED_BUILD_REPOSITORY);
  assert.equal(result.signerWorkflow, RUNALITH_HOSTED_BUILD_WORKFLOW);
  assert.equal(result.oidcIssuer, RUNALITH_HOSTED_BUILD_OIDC_ISSUER);
  assert.equal(result.productionReleaseEligible, false);
  assert.equal(result.releaseApprovalVerified, false);
  assert.equal(result.hostPolicyProvisioningAuthenticated, false);
  assert.equal(result.monotonicCheckpointVerified, false);
});

test('rejects digest, source commit, repository, predicate, subject cardinality and timestamp mismatches', () => {
  const negativeCases = [
    [verificationOutput({ digest: 'f'.repeat(64) }), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH'],
    [verificationOutput({ sourceCommit: '2'.repeat(40) }), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH'],
    [verificationOutput({ repositoryUrl: 'https://github.com/untrusted/repository' }), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH'],
    [verificationOutput({ predicateType: 'https://example.invalid/provenance/v1' }), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH'],
    [verificationOutput({ buildType: 'https://example.invalid/untrusted-build-type' }), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH'],
    [verificationOutput({ builderId: 'https://github.com/attacker/repo/.github/workflows/forged.yml@refs/heads/main' }), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH'],
    [verificationOutput({ subjectCount: 2 }), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH'],
    [verificationOutput({ timestampCount: 0 }), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH'],
    [verificationOutput({ timestampCount: 1 }).map(entry => ({
      ...entry,
      verificationResult: { ...entry.verificationResult, verifiedTimestamps: [{ type: 'Tlog', timestamp: new Date(Date.now() - 48 * 60 * 60_000).toISOString() }] }
    })), 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH']
  ];
  for (const [value, code] of negativeCases) {
    assert.throws(() => validateHostedBuilderVerificationOutput(value, { candidateSha256, sourceCommit: commit }),
      error => error.code === code);
  }
  assert.throws(() => validateHostedBuilderVerificationOutput(verificationOutput(), {
    candidateSha256, sourceCommit: commit, repository: 'attacker/fork'
  }), error => error.code === 'HOSTED_BUILDER_POLICY_INPUT_INVALID');
});

test('invokes gh with pinned issuer/repository/workflow/source digest and preserves a non-production verification record', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-gh-attestation-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidatePath = path.join(directory, 'candidate.mcpb');
  const bundlePath = path.join(directory, 'attestation.json');
  const reportPath = path.join(directory, 'verification.json');
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(bundlePath, Buffer.from('{"mediaType":"test-only-not-a-real-sigstore-bundle"}'), { flag: 'wx', mode: 0o600 });
  const argsSeen = [];
  const spawn = (executable, args, options) => {
    argsSeen.push({ executable, args, options });
    return { status: 0, stdout: JSON.stringify(verificationOutput()), stderr: '' };
  };
  const result = verifyHostedBuilderAttestation({ candidatePath, builderAttestationBundlePath: bundlePath,
    sourceCommit: commit, reportOutputPath: reportPath, spawn });
  assert.equal(result.status, 'HOSTED_BUILDER_PROVENANCE_VERIFIED');
  assert.equal(result.productionReleaseEligible, false);
  assert.equal(result.builderAttestationBundleSha256, createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex'));
  assert.equal(fs.existsSync(reportPath), true);
  assert.equal((fs.statSync(reportPath).mode & 0o777), 0o600);
  const invocation = argsSeen[0];
  assert.equal(invocation.executable, 'gh');
  assert.ok(invocation.args.includes('--repo'));
  assert.ok(invocation.args.includes(RUNALITH_HOSTED_BUILD_REPOSITORY));
  assert.ok(invocation.args.includes('--signer-workflow'));
  assert.ok(invocation.args.includes(`${RUNALITH_HOSTED_BUILD_REPOSITORY}/${RUNALITH_HOSTED_BUILD_WORKFLOW}`));
  assert.ok(invocation.args.includes('--signer-digest'));
  assert.ok(invocation.args.includes(commit));
  assert.ok(invocation.args.includes('--cert-oidc-issuer'));
  assert.ok(invocation.args.includes(RUNALITH_HOSTED_BUILD_OIDC_ISSUER));
  assert.ok(invocation.args.includes('--source-digest'));
  assert.ok(invocation.args.includes(commit));
  assert.ok(invocation.args.includes('--source-ref'));
  assert.ok(invocation.args.includes('refs/heads/main'));
  assert.ok(invocation.args.includes('--deny-self-hosted-runners'));
  assert.ok(invocation.args.includes('--predicate-type'));
  assert.ok(invocation.args.includes(RUNALITH_SLSA_PREDICATE));
  assert.equal(argsSeen.length, 2, 'API-associated attestation and downloaded signed bundle must be verified independently');
  assert.ok(argsSeen[1].args.includes('--bundle'));
  assert.ok(argsSeen[1].args.includes(bundlePath));
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).productionReleaseEligible, false);
  assert.throws(() => verifyHostedBuilderAttestation({ candidatePath, builderAttestationBundlePath: bundlePath,
    sourceCommit: commit, reportOutputPath: reportPath, spawn }),
    error => error.code === 'HOSTED_BUILDER_REPORT_PATH_UNSAFE');
});

test('fails closed when gh verification fails and detects candidate replacement after verifier execution', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-gh-attestation-negative-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidatePath = path.join(directory, 'candidate.mcpb');
  const bundlePath = path.join(directory, 'attestation.json');
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(bundlePath, Buffer.from('{"mediaType":"test-only-not-a-real-sigstore-bundle"}'), { flag: 'wx', mode: 0o600 });
  assert.throws(() => verifyHostedBuilderAttestation({ candidatePath, builderAttestationBundlePath: bundlePath, sourceCommit: commit,
    spawn: () => ({ status: 1, stdout: '', stderr: 'signature untrusted' }) }),
  error => error.code === 'HOSTED_BUILDER_ATTESTATION_NOT_VERIFIED');

  assert.throws(() => verifyHostedBuilderAttestation({ candidatePath, builderAttestationBundlePath: bundlePath, sourceCommit: commit,
    spawn: () => {
      fs.writeFileSync(candidatePath, Buffer.from('replacement content'));
      return { status: 0, stdout: JSON.stringify(verificationOutput()), stderr: '' };
    } }), error => error.code === 'HOSTED_BUILDER_CANDIDATE_CHANGED');
});

test('rejects API and downloaded-bundle verification results that identify different statements', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-gh-attestation-mismatch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidatePath = path.join(directory, 'candidate.mcpb');
  const bundlePath = path.join(directory, 'attestation.json');
  fs.writeFileSync(candidatePath, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(bundlePath, Buffer.from('{"mediaType":"test-only-not-a-real-sigstore-bundle"}'), { flag: 'wx', mode: 0o600 });
  let calls = 0;
  assert.throws(() => verifyHostedBuilderAttestation({ candidatePath, builderAttestationBundlePath: bundlePath, sourceCommit: commit,
    spawn: () => ({ status: 0, stdout: JSON.stringify(verificationOutput({ sourceCommit: calls++ === 0 ? commit : '2'.repeat(40) })), stderr: '' }) }),
  error => error.code === 'HOSTED_BUILDER_API_BUNDLE_STATEMENT_MISMATCH' || error.code === 'HOSTED_BUILDER_STATEMENT_BINDING_MISMATCH');
});
