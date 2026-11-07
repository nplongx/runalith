import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAuthorityDependencyRegister } from '../scripts/verify-agg-v2-authority-dependency-register.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const register = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/agg-v2-authority-dependency-register-20261030-v1.json'), 'utf8'));

test('authority dependency register is complete, unassigned and fail-closed', () => {
  const result = validateAuthorityDependencyRegister(register);
  assert.equal(result.result, 'BLOCKED_EXTERNAL_AUTHORITY_DEPENDENCIES');
  assert.equal(result.structurallyValid, true);
  assert.equal(result.dependencyCount, 19);
  assert.equal(result.unassignedOwnerCount, 19);
  assert.equal(result.productionAuthorityGranted, false);
});

test('authority dependency register rejects missing owner, evidence and verification fields', () => {
  const invalid = structuredClone(register);
  invalid.dependencies[0].accountableOwnerRole = '';
  assert.throws(() => validateAuthorityDependencyRegister(invalid), /accountableOwnerRole/);
  const missingArtifact = structuredClone(register);
  missingArtifact.dependencies[0].requiredArtifacts = [];
  assert.throws(() => validateAuthorityDependencyRegister(missingArtifact), /requiredArtifacts/);
  const missingVerifier = structuredClone(register);
  missingVerifier.dependencies[0].verificationProcedure = [];
  assert.throws(() => validateAuthorityDependencyRegister(missingVerifier), /verificationProcedure/);
});

test('authority dependency register cannot claim production authorization or mutation', () => {
  for (const field of ['productionAuthorityGranted', 'productionMutationPerformed', 'externalCheckpointAdvanceAttempted',
    'packageInstalledOrActivated', 'workflowOrTaskMutationPerformed', 'gitHistoryMutationPerformed']) {
    const invalid = structuredClone(register);
    invalid[field] = true;
    assert.throws(() => validateAuthorityDependencyRegister(invalid));
  }
});
