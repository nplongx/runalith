#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateAuthorityDependencyRegister(register) {
  assert.ok(register && typeof register === 'object' && !Array.isArray(register), 'register must be an object');
  assert.equal(register.schemaVersion, 1, 'unsupported register schemaVersion');
  assert.equal(register.recordType, 'runalith-agg-v2-authority-dependency-register', 'unsupported recordType');
  assert.equal(register.decision, 'BLOCKED', 'authority dependency register must remain BLOCKED');
  assert.equal(register.productionAuthorityGranted, false, 'register cannot grant production authority');
  assert.equal(register.productionMutationPerformed, false, 'register must not claim production mutation');
  assert.equal(register.externalCheckpointAdvanceAttempted, false, 'register must not claim checkpoint advancement');
  assert.equal(register.packageInstalledOrActivated, false, 'register must not claim package activation');
  assert.equal(register.workflowOrTaskMutationPerformed, false, 'register must not claim workflow/task mutation');
  assert.equal(register.gitHistoryMutationPerformed, false, 'register must not claim Git history mutation');
  assert.ok(register.candidate?.sha256 && /^[a-f0-9]{64}$/.test(register.candidate.sha256), 'candidate SHA-256 required');
  assert.ok(Array.isArray(register.releaseBlockers) && register.releaseBlockers.length >= 6, 'release blocker list incomplete');
  assert.ok(Array.isArray(register.dependencies) && register.dependencies.length >= 10, 'authority dependency list incomplete');

  const ids = new Set();
  const issueNumbers = new Set();
  let unassignedOwnerCount = 0;
  for (const [index, dependency] of register.dependencies.entries()) {
    const label = `dependencies[${index}]`;
    assert.ok(typeof dependency.id === 'string' && dependency.id.trim(), `${label}.id required`);
    assert.ok(!ids.has(dependency.id), `duplicate dependency id: ${dependency.id}`);
    ids.add(dependency.id);
    assert.ok(Array.isArray(dependency.issues) && dependency.issues.length > 0, `${label}.issues required`);
    for (const issue of dependency.issues) {
      assert.ok(Number.isInteger(issue) && issue > 0, `${label} has invalid issue number`);
      issueNumbers.add(issue);
    }
    assert.equal(dependency.issueStatusAtObservation, 'OPEN', `${label} must retain observed OPEN state`);
    if (dependency.assignedOwner === null) unassignedOwnerCount++;
    else assert.ok(typeof dependency.assignedOwner === 'string' && dependency.assignedOwner.trim(), `${label}.assignedOwner invalid`);
    for (const field of ['accountableOwnerRole', 'authority', 'decisionRequired', 'localStatus']) {
      assert.ok(typeof dependency[field] === 'string' && dependency[field].trim(), `${label}.${field} required`);
    }
    for (const field of ['requiredArtifacts', 'evidenceMissing', 'verificationProcedure']) {
      assert.ok(Array.isArray(dependency[field]) && dependency[field].length > 0 &&
        dependency[field].every(item => typeof item === 'string' && item.trim()), `${label}.${field} must be non-empty strings`);
    }
  }

  const blockerCodes = new Set(register.releaseBlockers.map(blocker => blocker.code));
  for (const code of [
    'PHASE2_FROZEN_71_PATH_CONTRACT_UNRESOLVED',
    'INDEPENDENT_RELEASE_EVIDENCE_NOT_VERIFIED',
    'PRODUCTION_AGG_TRUST_CONFIGURATION_NOT_VERIFIED',
    'PRODUCTION_AGG_TRUST_LEDGER_EXTERNAL_ANCHOR_NOT_VERIFIED',
    'ACTIVE_EXECUTING_WORKFLOWS_MUST_DRAIN',
    'RUNNING_TASKS_MUST_DRAIN',
    'CANDIDATE_VERSION_ALREADY_INSTALLED'
  ]) assert.ok(blockerCodes.has(code), `missing release blocker ${code}`);

  return {
    schemaVersion: 1,
    recordType: 'runalith-agg-v2-authority-dependency-register-validation',
    generatedAt: new Date().toISOString(),
    result: 'BLOCKED_EXTERNAL_AUTHORITY_DEPENDENCIES',
    structurallyValid: true,
    dependencyCount: register.dependencies.length,
    openIssueCount: issueNumbers.size,
    unassignedOwnerCount,
    releaseBlockerCount: register.releaseBlockers.length,
    candidateSha256: register.candidate.sha256,
    productionAuthorityGranted: false,
    caveats: [
      'Validation checks register structure and fail-closed declarations only; it does not query GitHub or verify signatures/authority.',
      'Issue states are observations and must be re-queried before operational use.',
      'Owner roles are not named or assigned owners; the register does not create approvals or attestations.'
    ]
  };
}

function main(argv) {
  const registerPath = path.join(ROOT, 'docs/agg-v2-authority-dependency-register-20261030-v1.json');
  const registerBytes = fs.readFileSync(registerPath);
  const register = JSON.parse(registerBytes.toString('utf8'));
  const report = validateAuthorityDependencyRegister(register);
  report.register = {
    path: path.relative(ROOT, registerPath),
    sha256: crypto.createHash('sha256').update(registerBytes).digest('hex'),
    sizeBytes: registerBytes.length
  };
  const outputIndex = argv.indexOf('--output');
  if (outputIndex >= 0) {
    const output = argv[outputIndex + 1];
    if (!output) throw new Error('--output requires a path');
    const absolute = path.resolve(ROOT, output);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Wrote ${path.relative(ROOT, absolute)}\n`);
  } else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`AGG_V2_AUTHORITY_REGISTER_INVALID: ${error.message}\n`); process.exitCode = 2; }
}
