#!/usr/bin/env node
/**
 * One-command local/source preflight for the AGG external-checkpoint v2 work.
 * Runs only read-only source checks and the dedicated disposable DB harness.
 * The docs checker starts an isolated local source subprocess for initialize /
 * tools/list; this never connects to the installed host MCP server or runs a
 * workflow tool. No GitHub, host-management or checkpoint API is called.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env }, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

function checkNewFilesWhitespace(additionalPaths = []) {
  const reviewedPaths = [
    'scripts/audit-agg-v2-event-callers.mjs',
    'scripts/audit-agg-v2-sql-mutation-callers.mjs',
    'scripts/verify-agg-v2-authority-dependency-register.mjs',
    'scripts/capture-agg-v2-disposable-db-contract.mjs',
    'scripts/run-agg-v2-local-preflight.mjs',
    'tests/test-agg-v2-sql-mutation-audit.mjs',
    'tests/test-agg-v2-authority-dependency-register.mjs',
    'tests/test-agg-rc23-to-rc71-migration.mjs',
    'docs/agg-external-checkpoint-v2-projection-inventory-20261030.md',
    'docs/agg-external-checkpoint-v2-projection-inventory-20261030-v0.6.md',
    'docs/agg-external-checkpoint-v2-projection-inventory-20261030-v0.8.md',
    'docs/agg-external-checkpoint-v2-projection-inventory-20261030-v0.9.md',
    'docs/agg-external-checkpoint-v2-projection-inventory-20261030-v0.10.md',
    'docs/agg-external-checkpoint-v2-projection-inventory-20261030-v0.11.md',
    'docs/agg-v2-authority-dependency-register-20261030-v1.json',
    'docs/agg-v2-authority-dependency-handoff-20261030-v1.md',
    'docs/agg-external-checkpoint-v2-implementation-tooling-20261030.md',
    'artifacts/adaptive-goal-graph/rc71-record-event-callers-20261030T073526Z.json',
    'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261030T104136Z-savepoint-classification.json',
    'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261030T122106Z-regex-exec-exclusion.json',
    'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261030T123552Z-regex-literal-aware.json',
    'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261030T123709Z-regex-literal-aware.json',
    'artifacts/adaptive-goal-graph/rc71-disposable-db-contract-restart-20261030T072225Z.json',
    ...additionalPaths
  ];
  const violations = [];
  for (const relative of reviewedPaths) {
    const absolute = path.join(ROOT, relative);
    const contents = fs.readFileSync(absolute, 'utf8');
    const lines = contents.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (/[ \t]+\r?$/.test(lines[index])) violations.push(`${relative}:${index + 1}: trailing whitespace`);
    }
  }
  if (violations.length) throw new Error(`new-file whitespace check failed:\n${violations.join('\n')}`);
  return { result: 'PASS', filesChecked: reviewedPaths.length };
}

function main(argv) {
  const startedAt = new Date().toISOString();
  runNode('scripts/audit-agg-v2-event-callers.mjs', ['--self-test']);
  const eventAudit = JSON.parse(runNode('scripts/audit-agg-v2-event-callers.mjs', ['--json']));
  runNode('scripts/audit-agg-v2-sql-mutation-callers.mjs', ['--self-test']);
  const sqlAuditStamp = startedAt.replace(/[^0-9]/g, '');
  const sqlAuditRelativePath = `artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-${sqlAuditStamp}.json`;
  runNode('scripts/audit-agg-v2-sql-mutation-callers.mjs', ['--output', path.join(ROOT, sqlAuditRelativePath)]);
  const sqlAuditBytes = fs.readFileSync(path.join(ROOT, sqlAuditRelativePath));
  const sqlAudit = JSON.parse(sqlAuditBytes.toString('utf8'));
  const dbContract = JSON.parse(runNode('scripts/capture-agg-v2-disposable-db-contract.mjs'));
  const historicalMigration = runCommand(process.execPath, ['--test', 'tests/test-agg-rc23-to-rc71-migration.mjs']);
  const d01RecoveryTests = runCommand(process.execPath, ['--test', 'tests/test-adaptive-goal-knowledge-verifier.mjs']);
  const sqlAuditTests = runCommand(process.execPath, ['--test', 'tests/test-agg-v2-sql-mutation-audit.mjs']);
  const authorityRegisterTests = runCommand(process.execPath, ['--test', 'tests/test-agg-v2-authority-dependency-register.mjs']);
  const authorityRegisterRelativePath = `artifacts/adaptive-goal-graph/agg-v2-authority-dependency-register-validation-${sqlAuditStamp}.json`;
  runNode('scripts/verify-agg-v2-authority-dependency-register.mjs', ['--output', path.join(ROOT, authorityRegisterRelativePath)]);
  const authorityRegisterBytes = fs.readFileSync(path.join(ROOT, authorityRegisterRelativePath));
  const authorityRegisterValidation = JSON.parse(authorityRegisterBytes.toString('utf8'));
  const docsCheck = runNode('scripts/check-docs.mjs');
  runCommand('git', ['diff', '--check']);
  const newFilesWhitespaceCheck = checkNewFilesWhitespace([sqlAuditRelativePath, authorityRegisterRelativePath]);
  const report = {
    schemaVersion: 1,
    auditKind: 'agg-v2-local-source-preflight',
    startedAt,
    completedAt: new Date().toISOString(),
    result: 'PASS_LOCAL_CHECKS_WITH_EXTERNAL_GATES_OPEN',
    sourceAudit: {
      configuredEntrypoint: eventAudit.configuredEntrypoint,
      sourceFilesScanned: eventAudit.sourceFilesScanned,
      recordEventCallsites: eventAudit.callsiteCount,
      literalCallsites: eventAudit.literalCallsiteCount,
      computedOrUnresolvedCallsites: eventAudit.computedOrUnresolvedCallsiteCount,
      distinctLiteralEventTypes: eventAudit.distinctLiteralEventTypeCount
    },
    directSqlAudit: {
      reportPath: sqlAuditRelativePath,
      reportSha256: crypto.createHash('sha256').update(sqlAuditBytes).digest('hex'),
      configuredEntrypoint: sqlAudit.configuredEntrypoint,
      sourceFilesScanned: sqlAudit.sourceFilesScanned,
      rawTextualCandidates: sqlAudit.rawTextualCandidateCount,
      multilineTextualCandidates: sqlAudit.multilineTextualCandidateCount,
      totalTextualCandidates: sqlAudit.totalTextualCandidateCount,
      directSqlCallsites: sqlAudit.directSqlCallsiteCount,
      unmatchedRawTextualCandidates: sqlAudit.unmatchedRawTextualCandidateCount,
      unmatchedByMaskReason: sqlAudit.unmatchedByMaskReason,
      multilineByMaskReason: sqlAudit.multilineByMaskReason,
      literalSqlCallsites: sqlAudit.literalSqlCallsiteCount,
      computedOrUnresolvedCallsites: sqlAudit.computedOrUnresolvedCallsiteCount,
      dataWriteCallsites: sqlAudit.dataWriteCallsiteCount,
      schemaWriteCallsites: sqlAudit.schemaWriteCallsiteCount,
      multiStatementCallsites: sqlAudit.multiStatementCallsiteCount,
      multiStatementMutationCallsites: sqlAudit.multiStatementMutationCallsiteCount,
      unresolvedCallsites: sqlAudit.unresolvedCallsiteCount,
      distinctReferencedObjects: sqlAudit.distinctReferencedObjectCount,
      referencedObjectCounts: sqlAudit.referencedObjectCounts,
      operationClassCounts: sqlAudit.operationClassCounts
    },
    authorityDependencyRegister: {
      sourcePath: 'docs/agg-v2-authority-dependency-register-20261030-v1.json',
      sourceSha256: authorityRegisterValidation.register.sha256,
      validationReportPath: authorityRegisterRelativePath,
      validationReportSha256: crypto.createHash('sha256').update(authorityRegisterBytes).digest('hex'),
      result: authorityRegisterValidation.result,
      structurallyValid: authorityRegisterValidation.structurallyValid,
      dependencyCount: authorityRegisterValidation.dependencyCount,
      openIssueCount: authorityRegisterValidation.openIssueCount,
      unassignedOwnerCount: authorityRegisterValidation.unassignedOwnerCount,
      productionAuthorityGranted: authorityRegisterValidation.productionAuthorityGranted
    },
    disposableDatabaseCheck: {
      workflowSchemaStableAcrossSecondStartup: dbContract.assertions.workflowSchemaStableAcrossSecondStartup,
      trustSchemaStableAcrossSecondStartup: dbContract.assertions.trustSchemaStableAcrossSecondStartup,
      workflow: dbContract.workflow.first,
      trustLedger: dbContract.trustLedger.first
    },
    validations: {
      eventCallerScannerSelfTest: 'PASS',
      directSqlMutationScannerSelfTest: 'PASS',
      directSqlMutationScannerTests: 'PASS',
      authorityDependencyRegisterTests: 'PASS',
      authorityDependencyRegisterStructure: 'PASS',
      disposableDatabaseStartupRestartReadback: 'PASS',
      historicalRc23ToRc71Migration: 'PASS',
      d01SplitDatabaseFaultInjectionAndSigkillRecovery: 'PASS',
      docsCheck: 'PASS',
      newFilesWhitespaceCheck,
      gitDiffCheck: 'PASS',
      docsCheckOutput: docsCheck,
      historicalMigrationOutput: historicalMigration,
      d01RecoveryTestsOutput: d01RecoveryTests,
      sqlMutationAuditTestsOutput: sqlAuditTests,
      authorityRegisterTestsOutput: authorityRegisterTests
    },
    externalAndAcceptanceGates: {
      v2IssueAcceptance: 'OPEN',
      productionTrustAndExternalCheckpointAuthority: 'NOT_PROVEN',
      independentAttestation: 'NOT_PROVEN',
      deployedProcessAndWorkerInventory: 'NOT_PROVEN',
      rollout: 'BLOCKED'
    },
    limitations: [
      'PASS covers local/source validation only; it does not imply issue acceptance or release readiness.',
      'The event scan is source-callsite discovery, not a complete event registry or reader/writer manifest.',
      'The direct SQL scan is lexical discovery only; aliases, generated SQL, imported wrappers and non-SQL mutation APIs may be missed. Multi-statement aggregates and computed SQL arguments remain unresolved for manual classification; it does not classify every callsite as authorization-relevant.',
      'The authority dependency register validator checks structure and fail-closed declarations only; it does not verify GitHub state, owner identity, signatures, provider authority or production evidence.',
      'The SQLite harness covers fresh source initialization and repeated startup only, not legacy upgrade/failure paths.',
      'The RC.23-to-RC.71 migration test exercises one immutable historical archive and restart/data-preservation path; it does not cover every intermediate schema, interrupted migration boundary, or power-loss recovery.',
      'No configured user database, production host, live MCP workflow, approval, task, lease, or checkpoint was accessed.'
    ]
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  const outputIndex = argv.indexOf('--output');
  if (outputIndex >= 0) {
    const outputPath = argv[outputIndex + 1];
    if (!outputPath) throw new Error('--output requires a file path');
    const absolute = path.resolve(ROOT, outputPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Wrote ${path.relative(ROOT, absolute)}\n`);
  } else process.stdout.write(json);
}

try { main(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
