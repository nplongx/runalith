import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serializePluginPackageMetadata } from '../scripts/plugin-package-metadata.mjs';
import { verifyMcpbSourceAlignment } from '../scripts/verify-mcpb-source-alignment.mjs';
import { captureAggPhase1EvidenceTreeIdentity, verifyAggPhase1EvidencePack } from '../scripts/verify-agg-phase1-evidence-pack.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const ignoredProtocolDocs = [
  'docs/plugin-workflow-benchmark-phase1-freeze.md',
  'docs/plugin-workflow-benchmark-preflight-evidence.md'
];
const requiredReplayCommands = [
  'tool-node', 'tool-npm', 'tool-git', 'tool-zip', 'tool-unzip', 'tool-tar', 'tool-platform',
  'focused-agg-phase1-tests', 'npm-test', 'docs-check', 'git-diff-check', 'package-reproducibility',
  'package-no-overwrite', 'mcpb-build-and-extracted-e2e', 'candidate-source-alignment', 'mcpb-extracted-fast-smoke',
  'offline-agg-algorithm-benchmark', 'offline-agg-ledger-integrity', 'official-readiness-fail-closed',
  'phase2-package-boundary-diagnostic'
];

function writeFile(root, relative, bytes) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
}

function walkFiles(root, prefix = '') {
  const result = [];
  const directory = path.join(root, prefix);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    const full = path.join(root, relative);
    if (entry.isSymbolicLink()) throw new Error('unexpected symlink in test fixture: ' + relative);
    if (entry.isDirectory()) result.push(...walkFiles(root, relative));
    else if (entry.isFile() && !['SHA256SUMS.txt', 'evidence-pack-manifest.json', 'evidence-pack-verification.json'].includes(relative)) result.push(relative);
  }
  return result;
}

function writeChecksums(root) {
  const rows = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (relative === 'SHA256SUMS.txt') continue;
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      assert.equal(stat.isSymbolicLink(), false, 'checksum walker refuses symlinks: ' + relative);
      if (stat.isDirectory()) walk(full, relative);
      else if (stat.isFile()) rows.push({ path: relative, sha256: digest(fs.readFileSync(full)) });
      else throw new Error('unexpected special file: ' + relative);
    }
  };
  walk(root);
  const bytes = rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(item => item.sha256 + '  ' + item.path).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), bytes, { flag: 'wx', mode: 0o600 });
}

test('independent verifier inventory detects same-byte inode replacement and directory/path drift', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase1-verifier-tree-identity-'));
  try {
    const evidence = path.join(temp, 'evidence');
    fs.mkdirSync(path.join(evidence, 'logs'), { recursive: true, mode: 0o700 });
    const target = path.join(evidence, 'logs', 'raw.log');
    fs.writeFileSync(target, 'same bytes\n', { flag: 'wx', mode: 0o600 });
    const initial = captureAggPhase1EvidenceTreeIdentity(evidence);
    assert.equal(captureAggPhase1EvidenceTreeIdentity(evidence).length, initial.length);

    const replacement = path.join(evidence, 'logs', 'replacement.tmp');
    fs.writeFileSync(replacement, 'same bytes\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(replacement, target);
    assert.notDeepEqual(captureAggPhase1EvidenceTreeIdentity(evidence), initial,
      'identical content at a replacement inode must not preserve the evidence snapshot identity');

    const afterReplacement = captureAggPhase1EvidenceTreeIdentity(evidence);
    fs.writeFileSync(path.join(evidence, 'added-receipt.json'), '{}\n', { flag: 'wx', mode: 0o600 });
    assert.notDeepEqual(captureAggPhase1EvidenceTreeIdentity(evidence), afterReplacement,
      'new evidence paths must change the complete tree inventory');

    const symlink = path.join(evidence, 'linked.log');
    fs.symlinkSync(target, symlink);
    assert.throws(() => captureAggPhase1EvidenceTreeIdentity(evidence),
      /symlink or path substitution inside evidence pack/,
      'symlink substitution must fail closed even if its target bytes are valid');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function createFixtureCommands(evidenceRoot, sourceRoot, candidatePath, provenancePath, snapshotMetadata) {
  const startedAt = '2026-10-23T00:00:00.000Z';
  const endedAt = startedAt;
  const stdout = Buffer.from('fixture command output\n');
  const stderr = Buffer.alloc(0);
  return requiredReplayCommands.map(name => {
    let command = 'node';
    let args = ['fixture', name];
    let envOverrides = {};
    const needsCandidateBinding = ['mcpb-build-and-extracted-e2e', 'candidate-source-alignment', 'mcpb-extracted-fast-smoke', 'phase2-package-boundary-diagnostic'].includes(name);
    if (name === 'mcpb-build-and-extracted-e2e') {
      command = 'npm'; args = ['run', 'pack:runalith-mcpb']; envOverrides = { PLUGIN_BUNDLE_OUT: candidatePath };
    } else if (name === 'candidate-source-alignment') {
      command = process.execPath; args = ['scripts/verify-mcpb-source-alignment.mjs', '--source-root', sourceRoot, '--bundle', candidatePath, '--output', provenancePath];
    } else if (name === 'mcpb-extracted-fast-smoke') {
      command = 'npm'; args = ['run', 'test:mcpb-candidate', '--', candidatePath];
    } else if (name === 'phase2-package-boundary-diagnostic') {
      command = process.execPath; args = ['scripts/verify-agg-phase1-phase2-package-boundary.mjs', '--phase1-bundle', candidatePath, '--output', path.join(evidenceRoot, 'phase2-package-boundary.json')];
    } else if (name.startsWith('tool-')) {
      const specs = {
        'tool-node': [process.execPath, ['--version']], 'tool-npm': ['npm', ['--version']], 'tool-git': ['git', ['--version']],
        'tool-zip': ['zip', ['-v']], 'tool-unzip': ['unzip', ['-v']], 'tool-tar': ['tar', ['--version']], 'tool-platform': ['uname', ['-srmo']]
      };
      [command, args] = specs[name];
    } else {
      const specs = {
        'npm-test': ['npm', ['test']], 'docs-check': ['npm', ['run', 'docs:check']],
        'git-diff-check': ['git', ['diff', '--check']], 'package-reproducibility': ['npm', ['run', 'test:package-reproducibility']],
        'package-no-overwrite': [process.execPath, ['tests/test-package-no-overwrite.js']],
        'offline-agg-algorithm-benchmark': [process.execPath, ['benchmarks/adaptive-goal-graph/run-phase1-benchmark.mjs', '--output', path.join(evidenceRoot, 'phase1-algorithm-raw.json'), '--report', path.join(evidenceRoot, 'phase1-algorithm-report.md')]],
        'offline-agg-ledger-integrity': [process.execPath, ['benchmarks/adaptive-goal-graph/verify-phase1-ledger.mjs', '--raw', path.join(evidenceRoot, 'phase1-algorithm-raw.json'), '--manifest', path.join(evidenceRoot, 'phase1-algorithm-raw.json.manifest.json')]],
        'official-readiness-fail-closed': [process.execPath, ['benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs', 'readiness', '--output', path.join(evidenceRoot, 'official-readiness.json')]]
      };
      if (specs[name]) [command, args] = specs[name];
      if (name === 'focused-agg-phase1-tests') { command = process.execPath; args = ['--test', 'tests/test-plugin-workflow-benchmark-phase1-protocol.mjs', 'tests/test-agg-phase1-evidence-pack-verifier.mjs']; }
    }
    const record = {
      name, command, args, startedAt, endedAt, durationMs: 0,
      cwd: sourceRoot, envOverrides, argvSha256: digest(Buffer.from(JSON.stringify([command, ...args]))),
      sourceBinding: {
        baseGitHead: snapshotMetadata.baseGitHead,
        sourceSnapshotSha256: snapshotMetadata.sourceSnapshotSha256,
        trackedPatchSha256: snapshotMetadata.trackedPatchSha256,
        untrackedSourceOverlaySha256: snapshotMetadata.untrackedSourceOverlaySha256
      },
      exitCode: 0, signal: null, spawnError: null,
      logPath: `logs/${name}.log`, stdoutPath: `logs/${name}.stdout.bin`, stderrPath: `logs/${name}.stderr.bin`,
      logSha256: '', stdoutSha256: digest(stdout), stderrSha256: digest(stderr)
    };
    if (needsCandidateBinding) record.candidateBinding = {
      path: candidatePath,
      sha256: digest(fs.readFileSync(candidatePath)),
      relation: ({ 'mcpb-build-and-extracted-e2e': 'produced', 'candidate-source-alignment': 'verified', 'mcpb-extracted-fast-smoke': 'consumed', 'phase2-package-boundary-diagnostic': 'compared' })[name]
    };
    writeFile(evidenceRoot, record.stdoutPath, stdout);
    writeFile(evidenceRoot, record.stderrPath, stderr);
    const log = Buffer.concat([
      Buffer.from(`COMMAND: ${record.command} ${record.args.join(' ')}\nCWD: ${record.cwd}\nARGV_JSON: ${JSON.stringify([record.command, ...record.args])}\nENV_OVERRIDES_JSON: ${JSON.stringify(record.envOverrides)}\nARGV_SHA256: ${record.argvSha256}\nSOURCE_BINDING_JSON: ${JSON.stringify(record.sourceBinding)}\nSTARTED_AT: ${record.startedAt}\nENDED_AT: ${record.endedAt}\nEXIT_CODE: 0\nSIGNAL: none\nERROR: none\nDURATION_MS: 0.000\n--- STDOUT ---\n`),
      stdout, Buffer.from('\n--- STDERR ---\n'), stderr, Buffer.from('\n')
    ]);
    record.logSha256 = digest(log);
    writeFile(evidenceRoot, record.logPath, log);
    return record;
  });
}

test('evidence-pack verifier binds every file, source snapshot, candidate bytes, provenance and blocked readiness', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phase1-evidence-pack-'));
  try {
    const sourceRoot = path.join(temp, 'source');
    const evidenceDir = path.join(temp, 'evidence');
    const stage = path.join(temp, 'stage');
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(evidenceDir);
    fs.mkdirSync(stage);

    const sourcePackage = { name: 'fixture', version: '1.0.0', description: 'test-only package', runtimeEntryPoint: 'server/index.js', type: 'module' };
    const pluginManifest = { version: '1.0.0', server: { entry_point: 'server/index.js' }, tools: [{ name: 'fixture_tool', description: 'fixture only' }] };
    writeFile(sourceRoot, 'package.json', jsonBytes(sourcePackage));
    writeFile(sourceRoot, 'plugin/manifest.json', jsonBytes(pluginManifest));
    writeFile(sourceRoot, 'README.md', Buffer.from('fixture README\n'));
    writeFile(sourceRoot, 'LICENSE', Buffer.from('fixture license\n'));
    writeFile(sourceRoot, 'server/index.js', Buffer.from('export const fixtureOnly = true;\n'));
    const sourceInputs = [
      'package-lock.json',
      'scripts/generate-mcp-reference.mjs',
      'scripts/package-runalith-mcpb.sh', 'scripts/collect-plugin-runtime.mjs', 'scripts/plugin-package-metadata.mjs',
      'scripts/verify-mcpb-source-alignment.mjs', 'scripts/validate-agg-trust-config.mjs',
      'scripts/reconcile-active-workflows.mjs',
      'scripts/reconcile-active-workflows-v2.mjs',
      'tests/test-reconcile-active-workflows.mjs',
      'tests/test-reconcile-active-workflows-v2.mjs',
      'benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs',
      'benchmarks/adaptive-goal-graph/run-benchmark.mjs',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v77.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v78.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v79.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v80.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v81.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v82.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v83.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v84.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v85.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v86.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v87.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v88.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v89.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v90.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v91.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v92.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v93.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v94.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v95.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v96.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v97.json',
  'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v98.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v99.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v100.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v101.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v102.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v103.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v104.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v105.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v106.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v107.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v108.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v109.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v110.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v111.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v112.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v113.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v114.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v115.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v116.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v117.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v118.json',
      'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v119.json',
      'tests/test-adaptive-goal-benchmark.mjs',
      'tests/test-mcp-eof-shutdown-framing-20261017.js',
      'tests/test-mcp-shutdown-backpressure-deadline-20261017.js',
      'server/index-v1.0.9-rc.38.js', 'server/index-v1.0.9-rc.39.js', 'server/index-v1.0.9-rc.40.js', 'docs/README.md',
      'benchmarks/plugin-workflow-benchmark/phase2-inventory-diagnostics.mjs',
      'benchmarks/plugin-workflow-benchmark/create-phase2-candidate-inventory.mjs',
      'benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs',
      'scripts/diagnose-phase2-archive-lineage.mjs',
      'tests/test-phase2-inventory-diagnostic-contract.mjs',
      'tests/test-adaptive-goal-execution-graph-proposal.js',
      'scripts/verify-agg-phase1-phase2-package-boundary.mjs',
      'tests/test-extracted-package-tool-schemas.mjs', 'benchmarks/plugin-workflow-benchmark/phase1-protocol-runner.mjs',
      'tests/test-agg-phase1-phase2-package-boundary.mjs',
      'tests/test-mcpb-source-alignment.mjs',
      'tests/test-plugin-workflow-benchmark-phase1-protocol.mjs',
      'scripts/test-mcpb-candidate.mjs',
      'src/runtime/strict-json.js', 'src/runtime/adaptive-goal-trust-configuration.js',
      'tests/test-adaptive-goal-trust-configuration.mjs', 'tests/test-adaptive-goal-trust-entrypoint.mjs',
      'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v1.json',
      'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v2.json',
      'docs/plugin-workflow-benchmark-plan.md',
      'scripts/replay-agg-phase1-finalization.mjs', 'scripts/verify-agg-phase1-evidence-pack.mjs',
      'tests/test-agg-phase1-evidence-pack-verifier.mjs',
      // Keep the fixture source tree complete as the source-alignment verifier
      // binds release-policy/verifier inputs in addition to packaged runtime
      // files. These files are inputs to the trust decision even when omitted
      // from this historical Phase 1 fixture archive.
      'scripts/lib/runalith-release-trust-contract.mjs', 'scripts/verify-release-evidence.mjs',
      'scripts/lib/hosted-builder-attestation.mjs', 'scripts/lib/hosted-verification-predicate.mjs',
      'scripts/lib/phase2-custody-evidence.mjs', 'scripts/verify-phase2-custody-evidence.mjs',
      'tests/test-phase2-custody-evidence.mjs',
      'scripts/verify-hosted-builder-provenance.mjs', 'scripts/create-hosted-candidate-verification-predicate.mjs',
      'scripts/runalith-hosted-build-policy.json', 'scripts/runalith-rollout.mjs',
      'tests/test-runalith-release-trust-contract.mjs', 'tests/test-hosted-builder-attestation.mjs',
      'tests/test-hosted-verification-predicate.mjs', 'tests/test-runalith-hosted-workflows.mjs',
      'tests/test-runalith-rollout.mjs',
      // Keep the synthetic source tree complete for the strengthened release
      // source-snapshot contract. These graph-chain implementations and tests,
      // plus the external checkpoint atomic-transition verifier, are now
      // release-critical inputs even when absent from this historical Phase 1
      // fixture's packaged archive.
      'src/runtime/adaptive-goal-graph.js', 'src/runtime/adaptive-goal-knowledge-store.js',
      'src/runtime/adaptive-goal-knowledge-verifier.js', 'src/runtime/adaptive-goal-plan-adapter.js',
      'src/runtime/adaptive-goal-compatibility.js', 'src/runtime/adaptive-goal-execution-readiness.js',
      'src/runtime/adaptive-goal-execution-graph-proposal.js', 'src/runtime/adaptive-goal-execution-plan-candidate.js',
      'src/runtime/adaptive-goal-reviewed-task-inputs.js', 'src/runtime/adaptive-goal-action-intent-policy.js',
      'src/runtime/adaptive-goal-reviewer-identity.js', 'src/runtime/adaptive-goal-source-evidence.js',
      'src/runtime/adaptive-goal-evidence-lineage.js', 'src/runtime/adaptive-goal-sandbox-executor.js',
      'tests/test-adaptive-goal-execution-plan-candidate.js', 'tests/test-adaptive-goal-current-scope-producer-e2e.mjs',
      'tests/test-adaptive-goal-knowledge-verifier.mjs', 'tests/test-adaptive-goal-reviewer-identity.js',
      'tests/test-adaptive-goal-evidence-lineage.js', 'scripts/lib/external-trust-checkpoint-contract.mjs',
      'scripts/lib/sqlite-external-checkpoint-transition.mjs', 'tests/test-external-trust-checkpoint-contract.mjs',
      '.github/workflows/runalith-provenance-builder.yml', '.github/workflows/runalith-provenance-verifier.yml',
      '.github/workflows/runalith-verification-attestation-signer.yml',
      'docs/runalith-provenance-release-trust-design.md', 'docs/runalith-hosted-builder-pipeline.md',
      'docs/runalith-release-evidence-verifier.md', 'docs/agg-production-trust-provisioning-runbook.md',
      'scripts/build-agg-readiness-dossier.mjs', 'tests/test-agg-readiness-dossier.mjs', 'tests/test-package-no-overwrite.js',
      'scripts/build-agg-live-remediation-plan.mjs', 'tests/test-agg-live-remediation-plan.mjs',
      'scripts/verify-agg-acceptance-consistency.mjs', 'tests/test-agg-acceptance-consistency.mjs',
      'tests/test-adaptive-goal-benchmark-integrity.mjs', 'tests/test-adaptive-goal-compatibility.js',
      'tests/test-adaptive-goal-knowledge-capture-mcp.mjs', 'tests/test-adaptive-goal-knowledge-capture.mjs',
      'tests/test-adaptive-goal-knowledge-store.js', 'tests/test-adaptive-goal-local-llm-failure.mjs',
      'tests/test-adaptive-goal-sandbox-executor.mjs', 'tests/test-adaptive-goal-source-evidence.js',
      'docs/runalith-rollout-rc28-20261028.md', 'docs/goal-plan-execution-acceptance-rc28-20261028.md',
      'docs/runalith-rollout-rc29-20261028.md', 'docs/goal-plan-execution-acceptance-rc29-20261028.md',
      'docs/runalith-rollout-rc30-20261028.md', 'docs/goal-plan-execution-acceptance-rc30-20261028.md',
      'docs/runalith-rollout-rc31-20261028.md', 'docs/goal-plan-execution-acceptance-rc31-20261028.md',
      'docs/runalith-rollout-rc32-20261028.md', 'docs/goal-plan-execution-acceptance-rc32-20261028.md',
      'docs/runalith-rollout-rc36-20261028.md', 'docs/runalith-rollout-rc37-20261028.md', 'docs/runalith-rollout-rc38-20261028.md',
      'server/index-v1.0.9-rc.41.js',
      'server/index-v1.0.9-rc.42.js',
      'server/index-v1.0.9-rc.43.js',
      'server/index-v1.0.9-rc.44.js',
      'server/index-v1.0.9-rc.45.js',
      'server/index-v1.0.9-rc.46.js',
      'server/index-v1.0.9-rc.47.js',
      'server/index-v1.0.9-rc.48.js',
      'server/index-v1.0.9-rc.49.js',
      'server/index-v1.0.9-rc.50.js',
      'server/index-v1.0.9-rc.51.js',
      'server/index-v1.0.9-rc.52.js',
      'server/index-v1.0.9-rc.53.js',
      'tests/test-workflow-terminal-failure-atomicity.js',
      'docs/runalith-production-readiness-workflow-engineering-20261028.md'
    ];
    for (const relative of sourceInputs) {
      writeFile(sourceRoot, relative, fs.readFileSync(path.join(repoRoot, relative)));
    }
    // These paths are deliberately owner-maintained, local-only source overlays.
    // The unit test uses synthetic content to exercise archive/hash binding; it
    // must not copy real operator evidence or assume those files exist on CI.
    writeFile(sourceRoot, ignoredProtocolDocs[0], Buffer.from(
      '# TEST FIXTURE ONLY — synthetic frozen protocol overlay\nNot an operational protocol, approval, or release input.\n', 'utf8'));
    writeFile(sourceRoot, ignoredProtocolDocs[1], Buffer.from(
      '# TEST FIXTURE ONLY — synthetic preflight overlay\nNo host observations or operational evidence are represented.\n', 'utf8'));
    execFileSync('git', ['init', '-q'], { cwd: sourceRoot });
    execFileSync('git', ['config', 'user.name', 'AGG Phase 1 verifier test'], { cwd: sourceRoot });
    execFileSync('git', ['config', 'user.email', 'agg-phase1-verifier-test@example.invalid'], { cwd: sourceRoot });
    fs.appendFileSync(path.join(sourceRoot, '.git', 'info', 'exclude'), `\n/${ignoredProtocolDocs[0]}\n/${ignoredProtocolDocs[1]}\n`);
    execFileSync('git', ['add', '-A'], { cwd: sourceRoot });
    execFileSync('git', ['commit', '-q', '-m', 'fixture frozen base snapshot'], { cwd: sourceRoot });
    const baseGitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    fs.appendFileSync(path.join(sourceRoot, 'README.md'), '\nTracked working-tree patch fixture.\n');

    for (const relative of ['README.md', 'LICENSE', 'server/index.js']) writeFile(stage, relative, fs.readFileSync(path.join(sourceRoot, relative)));
    writeFile(stage, 'manifest.json', fs.readFileSync(path.join(sourceRoot, 'plugin/manifest.json')));
    writeFile(stage, 'package.json', serializePluginPackageMetadata(sourcePackage));
    const candidatePath = path.join(evidenceDir, 'candidate.mcpb');
    execFileSync('zip', ['-X', '-q', candidatePath, 'README.md', 'LICENSE', 'manifest.json', 'package.json', 'server/index.js'], { cwd: stage });
    const provenance = verifyMcpbSourceAlignment({ sourceRoot, bundlePath: candidatePath });
    const provenancePath = path.join(evidenceDir, 'source-binary-provenance.json');
    writeFile(evidenceDir, 'source-binary-provenance.json', jsonBytes(provenance));

    const readiness = {
      decision: 'BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS',
      sourceProtocol: { targetBinding: { executionGateOpen: false, releaseApproved: false } },
      blockers: ['Fixture only: trusted ten-scenario corpus and operational A/B evidence are absent.'],
      acceptanceGates: {
        frozenPhase1ExecutionGateRemainsClosed: true,
        durableOneShotGateConsumptionEvidenceSuppliedToReadiness: false,
        executionGateOpenedByReadinessOrScorer: false
      }
    };
    writeFile(evidenceDir, 'official-readiness.json', jsonBytes(readiness));
    const phase2Boundary = {
      schemaVersion: 1,
      status: 'BLOCKED_PHASE2_FROZEN_COUNT_NOT_APPLICABLE_TO_CURRENT_PHASE1_PACKAGE',
      phase2ContractChanged: false,
      phase1ArchiveTrimmed: false,
      phase1CandidateSubstitutedAsPhase2Approval: false,
      officialAcceptanceClaimed: false,
      frozenPhase2RequiredEntryCount: 71,
      phase1: {
        path: 'candidate.mcpb', sha256: provenance.bundleSha256, sizeBytes: provenance.bundleBytes,
        version: '1.0.9-rc.5', archiveEntryCount: provenance.archiveEntryCount,
        manifestSha256: digest(fs.readFileSync(path.join(sourceRoot, 'plugin/manifest.json'))),
        manifestToolCount: provenance.manifestToolCount
      },
      historicalPhase2Reference: {
        path: 'historical-phase2-reference.mcpb',
        sha256: '2e9937d309e0c3085f9bf789b38ceff21b91c6fc093ba4ee344cf214c173a956',
        sizeBytes: 513203, version: '1.0.9-rc.5', archiveEntryCount: 71,
        manifestSha256: 'd'.repeat(64), manifestToolCount: 59,
        status: 'HISTORICAL_COUNT_REFERENCE_NOT_CURRENT_SOURCE_VERIFIED_NOT_APPROVED'
      },
      sameSemanticVersionString: true,
      packageContractsDiffer: true,
      pathDelta: { phase1Only: [], phase2Only: [] },
      toolDelta: { phase1Only: [], phase2Only: [] },
      observedBoundaryMatchesFrozenHistoricalShape: true
    };
    writeFile(evidenceDir, 'phase2-package-boundary.json', jsonBytes(phase2Boundary));

    const snapshotDir = path.join(evidenceDir, 'source-snapshot');
    fs.mkdirSync(snapshotDir);
    const patchBytes = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: sourceRoot, encoding: 'buffer' });
    writeFile(evidenceDir, 'source-snapshot/tracked-working-tree.patch', patchBytes);
    writeFile(evidenceDir, 'source-snapshot/git-status-normal-at-snapshot.txt', execFileSync('git', ['status', '--short', '--untracked-files=normal'], { cwd: sourceRoot }));
    writeFile(evidenceDir, 'source-snapshot/git-status-all-at-snapshot.txt', execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: sourceRoot }));
    const overlayPath = path.join(snapshotDir, 'untracked-source-overlay.tar.gz');
    execFileSync('tar', ['-czf', overlayPath, ...ignoredProtocolDocs], { cwd: sourceRoot });
    const overlayBytes = fs.readFileSync(overlayPath);
    const sourceOverlayEntries = ignoredProtocolDocs.map(relative => {
      const bytes = fs.readFileSync(path.join(sourceRoot, relative));
      return {
        path: relative, sizeBytes: bytes.byteLength, sha256: digest(bytes),
        mode: fs.statSync(path.join(sourceRoot, relative)).mode & 0o777
      };
    });
    const ignoredHashes = sourceOverlayEntries.map(({ path: relative, sha256 }) => ({ path: relative, sha256 }));
    const repositorySourceSnapshotSha256 = digest(Buffer.from(
      baseGitHead + '\0' + digest(patchBytes) + '\0' + digest(overlayBytes) + '\0', 'utf8'));
    const snapshotMetadata = {
      schemaVersion: 2, baseGitHead,
      trackedPatchSha256: digest(patchBytes), trackedPatchBytes: patchBytes.byteLength,
      untrackedSourceFileCount: 0, sourceOverlayFileCount: ignoredProtocolDocs.length,
      sourceOverlayEntries,
      ignoredButRetainedSourceFiles: ignoredHashes,
      untrackedSourceOverlaySha256: digest(overlayBytes), untrackedSourceOverlayBytes: overlayBytes.byteLength,
      sourceSnapshotSha256: repositorySourceSnapshotSha256,
      historicalArtifactsCopied: false, createdFromDirtyWorkingTree: true
    };
    writeFile(evidenceDir, 'source-snapshot/snapshot-metadata.json', jsonBytes(snapshotMetadata));
    const snapshotArchivePath = path.join(evidenceDir, 'source-snapshot-transport.tar.gz');
    execFileSync('tar', ['-czf', snapshotArchivePath, '-C', snapshotDir,
      'tracked-working-tree.patch', 'untracked-source-overlay.tar.gz', 'snapshot-metadata.json',
      'git-status-all-at-snapshot.txt', 'git-status-normal-at-snapshot.txt']);

    const candidate = {
      path: 'candidate.mcpb', sha256: provenance.bundleSha256, sizeBytes: provenance.bundleBytes,
      archiveEntryCount: provenance.archiveEntryCount, manifestToolCount: provenance.manifestToolCount,
      sourceSnapshotSha256: provenance.sourceSnapshotSha256
    };
    const statusReport = {
      schemaVersion: 1, disposition: 'DEVELOPMENT_CANDIDATE_VALIDATED_LOCALLY_NOT_OFFICIALLY_ACCEPTED',
      repository: { sourceSnapshotSha256: repositorySourceSnapshotSha256 }, candidate,
      verification: {
        gitDiffCheck: 'PASS',
        phase2BoundaryShapeVerified: true,
        phase2InventoryStatus: phase2Boundary.status
      },
      readiness: { decision: readiness.decision, executionGateOpen: false, releaseApproved: false },
      phase2PackageBoundaryReportPath: 'phase2-package-boundary.json',
      sourceSnapshotReconstruction: {
        status: 'PASS', candidateSha256: candidate.sha256,
        repositorySourceSnapshotSha256, candidateSourceSnapshotSha256: provenance.sourceSnapshotSha256
      }
    };
    writeFile(evidenceDir, 'candidate-final-status.json', jsonBytes(statusReport));
    writeFile(evidenceDir, 'release-checklist.md', Buffer.from('# Fixture release checklist\n\nIntegrity only; not acceptance.\n'));
    const commandResults = createFixtureCommands(evidenceDir, sourceRoot, candidatePath, provenancePath, snapshotMetadata);
    const toolchain = {
      node: 'fixture command output', npm: 'fixture command output', git: 'fixture command output', zip: 'fixture command output',
      unzip: 'fixture command output', tar: 'fixture command output', platform: 'fixture command output'
    };
    statusReport.commands = commandResults;
    statusReport.toolchain = toolchain;
    fs.writeFileSync(path.join(evidenceDir, 'candidate-final-status.json'), jsonBytes(statusReport));

    const snapshotManifest = {
      ...snapshotMetadata, snapshotArchivePath: 'source-snapshot-transport.tar.gz',
      snapshotArchiveSha256: digest(fs.readFileSync(snapshotArchivePath)),
      statusNormalPath: 'source-snapshot/git-status-normal-at-snapshot.txt',
      statusAllPath: 'source-snapshot/git-status-all-at-snapshot.txt'
    };
    const files = walkFiles(evidenceDir).map(relative => ({
      path: relative, sizeBytes: fs.statSync(path.join(evidenceDir, relative)).size,
      sha256: digest(fs.readFileSync(path.join(evidenceDir, relative)))
    }));
    const pack = {
      schemaVersion: 2, status: 'INTEGRITY_VERIFIED_NOT_ACCEPTANCE',
      disposition: 'DEVELOPMENT_CANDIDATE_VALIDATED_LOCALLY_NOT_OFFICIALLY_ACCEPTED',
      candidate,
      provenance: { path: 'source-binary-provenance.json', sha256: digest(fs.readFileSync(path.join(evidenceDir, 'source-binary-provenance.json'))) },
      readiness: { reportPath: 'official-readiness.json', decision: readiness.decision, executionGateOpen: false, releaseApproved: false },
      sourceSnapshot: snapshotManifest,
      phase2Boundary: { ...phase2Boundary, reportPath: 'phase2-package-boundary.json' },
      commandResults,
      toolchain,
      sourceSnapshotReconstruction: {
        status: 'PASS', baseGitHead, sourceSnapshotSha256: repositorySourceSnapshotSha256,
        candidateSourceSnapshotSha256: provenance.sourceSnapshotSha256, candidateSha256: candidate.sha256
      },
      verificationReportPath: 'evidence-pack-verification.json',
      files
    };
    writeFile(evidenceDir, 'evidence-pack-manifest.json', jsonBytes(pack));
    writeChecksums(evidenceDir);
    execFileSync('sha256sum', ['-c', 'SHA256SUMS.txt'], { cwd: evidenceDir, encoding: 'utf8' });

    const preflight = verifyAggPhase1EvidencePack({ evidenceDir, sourceRoot, allowMissingVerificationReport: true });
    assert.equal(preflight.status, 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE');
    const verificationReport = {
      schemaVersion: 1, status: 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE', verifiedAt: new Date().toISOString(),
      manifestSha256: digest(fs.readFileSync(path.join(evidenceDir, 'evidence-pack-manifest.json'))),
      candidateSha256: candidate.sha256,
      sourceSnapshotSha256: provenance.sourceSnapshotSha256,
      repositorySourceSnapshotSha256,
      readinessDecision: readiness.decision,
      checksumVerificationStatus: 'PASS', cleanCloneReconstructionStatus: 'PASS',
      evidenceFilesVerified: preflight.evidenceFilesVerified,
      acceptanceClaimed: false, releaseApproved: false
    };
    writeFile(evidenceDir, 'evidence-pack-verification.json', jsonBytes(verificationReport));
    fs.unlinkSync(path.join(evidenceDir, 'SHA256SUMS.txt'));
    writeChecksums(evidenceDir);
    execFileSync('sha256sum', ['-c', 'SHA256SUMS.txt'], { cwd: evidenceDir, encoding: 'utf8' });

    const verified = verifyAggPhase1EvidencePack({ evidenceDir, sourceRoot });
    assert.equal(verified.status, 'PASS_INTEGRITY_ONLY_NOT_ACCEPTANCE');
    assert.equal(verified.candidateSha256, candidate.sha256);
    assert.equal(verified.sourceSnapshotSha256, candidate.sourceSnapshotSha256);
    assert.equal(verified.repositorySourceSnapshotSha256, repositorySourceSnapshotSha256);
    assert.equal(verified.readinessDecision, 'BLOCKED_NO_TRUSTED_CORPUS_OR_REAL_AB_RUNS');
    assert.equal(verified.acceptanceClaimed, false);
    assert.equal(verified.currentSourceRootStatus, 'PASS_CURRENT_SOURCE_ROOT_MATCHES_CAPTURED_GIT_AND_OVERLAY_STATE');

    const readmePath = path.join(sourceRoot, 'README.md');
    const capturedReadmeBytes = fs.readFileSync(readmePath);
    fs.writeFileSync(readmePath, Buffer.concat([capturedReadmeBytes, Buffer.from('unrecorded post-snapshot drift\n')]));
    assert.throws(() => verifyAggPhase1EvidencePack({ evidenceDir, sourceRoot }),
      /current Git HEAD or tracked working-tree patch differs from the source snapshot|source\/archive byte mismatch for README\.md/,
      'the verifier must reject a cleanly re-hashed pack when the current source root has drifted from the captured snapshot');
    fs.writeFileSync(readmePath, capturedReadmeBytes);

    writeFile(evidenceDir, 'unbound-extra.txt', Buffer.from('unlisted evidence injection\n'));
    assert.throws(() => verifyAggPhase1EvidencePack({ evidenceDir, sourceRoot }), /not listed in SHA256SUMS\.txt/);
    fs.unlinkSync(path.join(evidenceDir, 'unbound-extra.txt'));

    const manifestPath = path.join(evidenceDir, 'evidence-pack-manifest.json');
    const originalManifest = fs.readFileSync(manifestPath, 'utf8');
    fs.writeFileSync(manifestPath, originalManifest.replace(
      '"status": "INTEGRITY_VERIFIED_NOT_ACCEPTANCE",',
      '"status": "INTEGRITY_VERIFIED_NOT_ACCEPTANCE",\n  "status": "ACCEPTED",'
    ));
    assert.throws(() => verifyAggPhase1EvidencePack({ evidenceDir, sourceRoot }), /duplicate|strict/i,
      'duplicate JSON keys must be rejected before trust decisions');
    fs.writeFileSync(manifestPath, originalManifest);

    const commandMutationDir = path.join(temp, 'command-ledger-mutation');
    fs.cpSync(evidenceDir, commandMutationDir, { recursive: true, errorOnExist: true });
    const commandManifestPath = path.join(commandMutationDir, 'evidence-pack-manifest.json');
    const commandManifest = JSON.parse(fs.readFileSync(commandManifestPath, 'utf8'));
    commandManifest.commandResults = commandManifest.commandResults.filter(item => item.name !== 'offline-agg-ledger-integrity');
    fs.writeFileSync(commandManifestPath, jsonBytes(commandManifest));
    const commandVerificationPath = path.join(commandMutationDir, 'evidence-pack-verification.json');
    const commandVerification = JSON.parse(fs.readFileSync(commandVerificationPath, 'utf8'));
    commandVerification.manifestSha256 = digest(fs.readFileSync(commandManifestPath));
    fs.writeFileSync(commandVerificationPath, jsonBytes(commandVerification));
    fs.unlinkSync(path.join(commandMutationDir, 'SHA256SUMS.txt'));
    writeChecksums(commandMutationDir);
    assert.throws(() => verifyAggPhase1EvidencePack({ evidenceDir: commandMutationDir, sourceRoot }),
      /command ledger is incomplete/, 'a fully re-hashed pack must still fail when a required command receipt has been omitted');

    const logMutationDir = path.join(temp, 'command-log-mutation');
    fs.cpSync(evidenceDir, logMutationDir, { recursive: true, errorOnExist: true });
    const logManifestPath = path.join(logMutationDir, 'evidence-pack-manifest.json');
    const logManifest = JSON.parse(fs.readFileSync(logManifestPath, 'utf8'));
    const outputPath = 'logs/npm-test.stdout.bin';
    fs.appendFileSync(path.join(logMutationDir, outputPath), 'post-hoc output substitution\n');
    const outputBytes = fs.readFileSync(path.join(logMutationDir, outputPath));
    const outputEntry = logManifest.files.find(item => item.path === outputPath);
    outputEntry.sizeBytes = outputBytes.byteLength;
    outputEntry.sha256 = digest(outputBytes);
    fs.writeFileSync(logManifestPath, jsonBytes(logManifest));
    const logVerificationPath = path.join(logMutationDir, 'evidence-pack-verification.json');
    const logVerification = JSON.parse(fs.readFileSync(logVerificationPath, 'utf8'));
    logVerification.manifestSha256 = digest(fs.readFileSync(logManifestPath));
    fs.writeFileSync(logVerificationPath, jsonBytes(logVerification));
    fs.unlinkSync(path.join(logMutationDir, 'SHA256SUMS.txt'));
    writeChecksums(logMutationDir);
    assert.throws(() => verifyAggPhase1EvidencePack({ evidenceDir: logMutationDir, sourceRoot }),
      /command npm-test log\/stdout\/stderr hashes do not match/,
      're-hashing the inventory must not let modified raw command output replace the immutable command receipt hashes');

    fs.writeFileSync(path.join(evidenceDir, 'official-readiness.json'), '{"decision":"ACCEPTED"}\n');
    assert.throws(() => verifyAggPhase1EvidencePack({ evidenceDir, sourceRoot }), /evidence file hash\/size mismatch: official-readiness\.json/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
