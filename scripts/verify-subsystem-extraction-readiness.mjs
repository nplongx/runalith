#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(ROOT, 'docs/subsystems/public-repository-snapshots.json');
const REQUIRED_STATEFUL_BLOCKERS = Object.freeze([
  'WORKFLOW_RUNTIME_NOT_STANDALONE',
  'EXECUTION_RUNTIME_PHYSICAL_PERSISTENCE_NOT_EXTRACTED',
  'AGENT_RUNTIME_SHARED_DATABASE_LIFECYCLE',
  'NO_STATEFUL_SUBSYSTEM_INDEPENDENT_CI_VERSION_ROLLBACK',
  'M12_UNKNOWN_OUTCOME_RECONCILIATION_MISSING',
  'TRUST_LEDGER_D01_CROSS_DATABASE'
]);

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fail(message) { throw new Error(message); }

function runCheck(name, command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false' } });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    name, command: [command, ...args].join(' '), cwd: path.relative(ROOT, cwd) || '.',
    exitCode: result.status ?? null, signal: result.signal || null,
    stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
    stdoutTail: stdout.slice(-5000), stderrTail: stderr.slice(-3000),
    passed: result.status === 0 && !result.error,
    error: result.error ? String(result.error.message || result.error) : null
  };
}

function verifyPinnedSnapshots() {
  const bytes = fs.readFileSync(SNAPSHOT_PATH);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.snapshots) || manifest.snapshots.length !== 4) {
    fail('public snapshot manifest must contain exactly four versioned public repositories');
  }
  const repositories = manifest.snapshots.map(snapshot => {
    if (!/^https:\/\/github\.com\//.test(snapshot.repository) || !/^[a-f0-9]{40}$/.test(snapshot.commit)) {
      fail(`invalid repository or pinned commit in ${snapshot.name}`);
    }
    let fileCount = 0;
    for (const file of snapshot.files || []) {
      if (!file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        fail(`invalid path/hash in public snapshot ${snapshot.name}`);
      }
      const source = path.join(ROOT, snapshot.localRoot, file.path);
      const actual = sha256(fs.readFileSync(source));
      if (actual !== file.sha256) fail(`${snapshot.name}:${file.path} differs from its pinned public snapshot`);
      fileCount += 1;
    }
    return { name: snapshot.name, repository: snapshot.repository, commit: snapshot.commit, mirroredFiles: fileCount,
      localBytesMatchPinnedSnapshot: true, remoteHeadRevalidatedThisRun: false };
  });
  return { manifestPath: path.relative(ROOT, SNAPSHOT_PATH), manifestSha256: sha256(bytes), repositories,
    repositoryCount: repositories.length, mirroredFileCount: repositories.reduce((sum, item) => sum + item.mirroredFiles, 0) };
}

function statefulSubsystemReadiness() {
  const hasCi = name => fs.existsSync(path.join(ROOT, '.github/workflows', name));
  const hasPackage = relative => fs.existsSync(path.join(ROOT, relative, 'package.json'));
  return [
    { subsystem: 'Workflow Runtime', packageRootPresent: hasPackage('subsystems/workflow-runtime'), independentCiPresent: hasCi('workflow-runtime.yml'),
      status: 'BLOCKED', blockers: ['WorkflowStore still owns mixed Workflow/Execution DDL and transaction groups', 'No standalone package root or clean-clone build/test evidence', 'Shared event journal and Agent Session lifecycle transaction participants remain'] },
    { subsystem: 'Execution Runtime', packageRootPresent: hasPackage('subsystems/execution-runtime'), independentCiPresent: hasCi('execution-runtime.yml'),
      status: 'BLOCKED', blockers: ['Provider dispatch-intent and provider-run ledger writes are extracted, but attempts, results, task leases, execution batches, task projections, shared journal and M12 start-intent/runtime remain Workflow-owned or mixed transaction groups', 'Cross-domain send/result/lease fences intentionally share WorkflowStatePort SQLite connection; no independent Execution transaction boundary exists', 'M12 Gateway unknown outcomes lack authoritative lookup/reconciliation'] },
    { subsystem: 'Agent Session Runtime', packageRootPresent: hasPackage('subsystems/agent-session-runtime'), independentCiPresent: hasCi('agent-session-runtime.yml'),
      status: 'BLOCKED', blockers: ['AgentSessionStore owns its tables but shares Workflow SQLite/FKs/events', 'Retry/completion/terminalization use same-connection lifecycle participant', 'No standalone clean-clone package, independent release/version or rollback proof'] }
  ];
}

function writeExclusive(outputPath, contents) {
  const absolute = path.resolve(outputPath);
  const parent = path.dirname(absolute);
  if (fs.realpathSync(parent) !== parent) fail('output parent must be canonical and not symlinked');
  const fd = fs.openSync(absolute, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return absolute;
}

function parseArgs(argv) {
  const args = { out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail('--out requires a new output path');
      args.out = value;
    } else fail(`unsupported argument: ${argv[index]}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const checks = [
    runCheck('workflow-state-port-and-boundaries', 'npm', ['run', 'test:workflow-state-port']),
    runCheck('agent-session-store-boundary', process.execPath, ['--test', 'tests/test-agent-session-store-boundary.mjs']),
    runCheck('public-repository-snapshot-and-facade', process.execPath, ['tests/test-subsystem-public-repo-alignment.mjs']),
    runCheck('cos-ap-packed-installed-consumer', process.execPath, ['scripts/test-cos-ap-packed-consumer.mjs']),
    runCheck('cos-ap-wire-contract', process.execPath, ['tests/test-cos-ap-v1.js']),
    runCheck('goal-idea-plan-execution-graph-e2e-and-negative', process.execPath, ['--test',
      'tests/test-adaptive-goal-current-scope-producer-e2e.mjs', 'tests/test-adaptive-goal-execution-graph-proposal.js',
      'tests/test-adaptive-goal-execution-readiness.js', 'tests/test-adaptive-goal-reviewer-identity.js',
      'tests/test-adaptive-goal-sandbox-receipt-integrity.mjs', 'tests/test-adaptive-goal-store-dispatch-guard.mjs',
      'tests/test-adaptive-goal-approval-subsystem.mjs', 'tests/test-adaptive-goal-knowledge-verifier.mjs',
      'tests/test-adaptive-goal-evidence-lineage.js', 'tests/test-adaptive-goal-execution-plan-candidate.js',
      'tests/test-adaptive-goal-candidate-assessment-contract.mjs', 'tests/test-phase2-custody-evidence.mjs',
      'tests/test-phase2-inventory-diagnostic-contract.mjs']),
    runCheck('production-trust-and-external-checkpoint-contracts', process.execPath, ['--test',
      'tests/test-adaptive-goal-trust-configuration.mjs', 'tests/test-adaptive-goal-trust-entrypoint.mjs',
      'tests/test-external-trust-checkpoint-contract.mjs', 'tests/test-runalith-release-trust-contract.mjs']),
    runCheck('execution-persistence-concurrency-and-recovery', process.execPath, ['--test',
      'tests/test-execution-persistence-participant-boundary.mjs', 'tests/test-execution-lease-fencing.js',
      'tests/test-workflow-terminal-failure-atomicity.js', 'tests/test-adaptive-goal-transaction-boundary.mjs']),
    runCheck('historical-archive-and-migration-integrity', process.execPath, ['--test', 'tests/test-agg-rc23-to-rc71-migration.mjs']),
    runCheck('versioned-provenance-and-agg-v2-inventories', process.execPath, ['--test',
      'tests/test-adaptive-goal-benchmark.mjs', 'tests/test-agg-v2-event-callers.mjs', 'tests/test-agg-v2-sql-mutation-audit.mjs']),
    runCheck('package-reproducibility', process.execPath, ['tests/test-package-reproducibility.js']),
    runCheck('mcpb-source-alignment-regressions', process.execPath, ['--test', 'tests/test-mcpb-source-alignment.mjs']),
    runCheck('documentation-links', 'npm', ['run', 'docs:check']),
    runCheck('git-diff-check', 'git', ['diff', '--check'])
  ];
  const snapshots = verifyPinnedSnapshots();
  const stateful = statefulSubsystemReadiness();
  const failedChecks = checks.filter(check => !check.passed);
  const blockers = [...REQUIRED_STATEFUL_BLOCKERS];
  if (failedChecks.length) blockers.push('LOCAL_ACCEPTANCE_CHECK_FAILURE');
  const report = {
    schemaVersion: 1,
    recordType: 'runalith-subsystem-extraction-readiness',
    generatedAt: new Date().toISOString(),
    evidenceClass: 'local source, package and regression acceptance; not independent release provenance or production authority',
    result: failedChecks.length ? 'FAIL' : 'BLOCKED',
    canExtractAllStatefulSubsystems: false,
    publicPureRepositories: snapshots,
    checks,
    statefulSubsystems: stateful,
    blockers: [...new Set(blockers)],
    authorityAndOperationalGates: {
      frozen71PathContract: 'UNRESOLVED_OWNER_SIGNED_MANIFEST_REQUIRED',
      independentReleaseProvenance: 'NOT_VERIFIED',
      productionTrustConfiguration: 'NOT_VERIFIED',
      externalTrustLedgerAnchor: 'NOT_VERIFIED',
      activeWorkflowAndRunningTaskDrain: 'NOT_AUTHORIZED_OR_VERIFIED',
      hostManagedActivationAndRollback: 'NOT_VERIFIED'
    },
    safety: { liveDatabaseMutationPerformed: false, trustMutationPerformed: false, processRestarted: false,
      packagePublishedOrInstalledOnHost: false, productionDispatchPerformed: false, gitHistoryMutationPerformed: false }
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) report.output = { path: writeExclusive(args.out, serialized), sha256: sha256(serialized), sizeBytes: Buffer.byteLength(serialized) };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return failedChecks.length ? 2 : 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ result: 'FAIL', code: 'SUBSYSTEM_EXTRACTION_READINESS_INPUT_INVALID',
      message: String(error?.message || error), productionAuthorityGranted: false })}\n`);
    process.exitCode = 2;
  }
}
