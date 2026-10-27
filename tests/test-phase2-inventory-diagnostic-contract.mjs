import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPhase2CandidateFailure, diagnosePhase2EntryCount, FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT
} from '../benchmarks/plugin-workflow-benchmark/phase2-inventory-diagnostics.mjs';

test('classifies historical manifest/source lineage mismatch separately from payload mismatch', () => {
  assert.deepEqual(classifyPhase2CandidateFailure('Error: source/archive bytes differ for manifest.json; refusing to create lineage inventory'), {
    classification: 'historical_source_manifest_lineage_mismatch', firstMismatchedEntry: 'manifest.json'
  });
  assert.deepEqual(classifyPhase2CandidateFailure('Error: source/archive bytes differ for src/runtime/job-store.js; refusing to create lineage inventory'), {
    classification: 'archive_payload_source_mismatch', firstMismatchedEntry: 'src/runtime/job-store.js'
  });
});

test('reports the source-aligned 76-entry inventory as a distinct frozen-contract blocker', () => {
  assert.equal(FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT, 71);
  assert.deepEqual(diagnosePhase2EntryCount(71), {
    classification: 'frozen_inventory_count_match', expectedFrozenEntryCount: 71,
    observedEntryCount: 71, acceptanceContractChanged: false
  });
  assert.deepEqual(diagnosePhase2EntryCount(76), {
    classification: 'frozen_inventory_count_mismatch', expectedFrozenEntryCount: 71,
    observedEntryCount: 76, acceptanceContractChanged: false
  });
  assert.throws(() => diagnosePhase2EntryCount(-1), /non-negative safe integer/);
  assert.throws(() => diagnosePhase2EntryCount(71.5), /non-negative safe integer/);
});

test('distinguishes malformed/path security failures from the three count/lineage diagnoses', () => {
  assert.equal(classifyPhase2CandidateFailure('Error: candidate archive has duplicate or unsafe entry paths').classification, 'unsafe_archive_path');
  assert.equal(classifyPhase2CandidateFailure('Error: source path is missing or contains a symlink: README.md').classification, 'source_path_symlink_or_missing');
  assert.equal(classifyPhase2CandidateFailure('unexpected validator exit').classification, 'candidate_inventory_rejected');
});

test('historical RC.11 alignment report does not turn its recorded Git HEAD into an exact source snapshot', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundleRelative = 'artifacts/mcpb-candidate-build-20261026T1745+0700/runalith-1.0.9-rc.11-goal-idea-authenticated-projection-v22.mcpb';
  const reportRelative = 'artifacts/adaptive-goal-graph/rc11-final-verification-20261026T1745+0700-source-alignment.json';
  const bundle = path.join(root, bundleRelative);
  const historicalReport = JSON.parse(fs.readFileSync(path.join(root, reportRelative), 'utf8'));
  const sourceHead = 'ff15b21934e5fd4920eea4b0816f6dc35d7f328a';
  const rc11Commit = 'ffee0815b8dfcac21d15d8eaeaf1d309aab2b7e2';
  const diagnostic = spawnSync(process.execPath, [
    path.join(root, 'scripts/diagnose-phase2-archive-lineage.mjs'),
    '--source-commit', sourceHead,
    '--source-commit', rc11Commit,
    '--source-commit', '3becc361c411e1c04f5c41ea8c153ba4a3360dd2',
    bundleRelative
  ], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  const current = JSON.parse(diagnostic.stdout);
  assert.equal(current.schemaVersion, 2, 'per-path custody matrix is an explicit diagnostic schema successor');
  const archive = current.archives[0];
  assert.equal(archive.sha256, historicalReport.bundleSha256, 'historical artifact bytes must remain unchanged');
  assert.equal(historicalReport.sourceGitHead, sourceHead);
  assert.equal(historicalReport.exactSourceByteMatchCount, 92);
  assert.equal(archive.archiveEntryCount, 93);
  assert.equal(current.frozenContract.contractKind, 'frozen-entry-count-only');
  assert.equal(current.frozenContract.authoritativePathListAvailable, false,
    'the historical contract freezes count, not an authenticated canonical path manifest');
  assert.equal(current.frozenContract.contractDefinitionCommit, 'ffee0815b8dfcac21d15d8eaeaf1d309aab2b7e2');
  assert.equal(archive.perPathProvenance.length, 92, 'per-path custody must account for every non-generated source entry');
  const actionIntentPath = archive.perPathProvenance.find(item => item.archivePath === 'src/runtime/adaptive-goal-action-intent-policy.js');
  assert.ok(actionIntentPath, 'per-path custody must include the known unattributed action-intent payload');
  assert.equal(actionIntentPath.archiveSha256, '68b5c8df808bef6301f58e125940eb3cbd27449303c2c95e9f6afab377c40070');
  assert.equal(actionIntentPath.reachableGitTreeCommitCount, 0);
  assert.equal(actionIntentPath.custodyClassification, 'blob_object_present_but_no_reachable_commit_tree_contains_exact_path_blob');
  const strictJsonPath = archive.perPathProvenance.find(item => item.archivePath === 'src/runtime/strict-json.js');
  assert.ok(strictJsonPath.reachableGitTreeCommitCount > 0, 'known tracked source must list reachable commits containing the exact path/blob pair');
  assert.ok(strictJsonPath.reachableGitTreeCommits.every(commit => /^[a-f0-9]{40}$/.test(commit)));
  assert.equal(archive.bestHistoricalTreeBySourceEntryMatch.commit, rc11Commit);
  assert.equal(archive.bestHistoricalTreeBySourceEntryMatch.exactSourceEntryMatches, 90);
  assert.equal(archive.bestHistoricalTreeBySourceEntryMatch.comparedSourceEntries, 92);
  assert.equal(archive.historicalSourceCommitMatchStatus, 'NO_SINGLE_GIT_COMMIT_MATCHES_ALL_PACKAGED_SOURCE_ENTRIES');
  assert.deepEqual(archive.requiredMissingEvidence, [
    'authenticated source snapshot or build receipt binding this exact archive SHA-256 to a source tree',
    'independently authenticated builder identity and source-tree cleanliness/dirty-diff evidence',
    'independent release approval and production authority evidence'
  ]);
  const historicalMismatches = archive.bestHistoricalTreeBySourceEntryMatch.firstMismatches;
  assert.deepEqual(historicalMismatches.map(item => item.path).sort(), [
    'src/runtime/adaptive-goal-action-intent-policy.js', 'src/runtime/adaptive-goal-knowledge-capture.js'
  ].sort());
  assert.deepEqual(historicalMismatches.map(item => ({ path: item.path, archiveSha256: item.archiveSha256,
    archiveGitBlobSha1: item.archiveGitBlobSha1, commitBlobOid: item.commitBlobOid, reachableCommitBlobMatchCount: item.reachableCommitBlobMatchCount,
    allGitTreeBlobMatchCount: item.allGitTreeBlobMatchCount, gitObjectDatabase: item.gitObjectDatabase })), [
    { path: 'src/runtime/adaptive-goal-action-intent-policy.js', archiveSha256: '68b5c8df808bef6301f58e125940eb3cbd27449303c2c95e9f6afab377c40070',
      archiveGitBlobSha1: '5bb67e0e5e81b1f234e08a336d73ebc780d82a8b', commitBlobOid: 'ba8ef74ed2fe764fa07f327c96a8f6e2e90ce05b', reachableCommitBlobMatchCount: 0,
      allGitTreeBlobMatchCount: 0,
      gitObjectDatabase: { objectPresent: true, objectType: 'blob', reachability: 'NOT_FOUND_IN_REACHABLE_COMMIT_TREES' } },
    { path: 'src/runtime/adaptive-goal-knowledge-capture.js', archiveSha256: 'f962fa982bd8d73a9e4290ec71f002407c144897b95c97139111fab50e47212d',
      archiveGitBlobSha1: '073ebe6e1f1096a2ad92d5897e0ad9dc7ad0f06e', commitBlobOid: '36011b1a41cd18d2aed62e9732501a1a8b9cde09', reachableCommitBlobMatchCount: 0,
      allGitTreeBlobMatchCount: 0,
      gitObjectDatabase: { objectPresent: true, objectType: 'blob', reachability: 'NOT_FOUND_IN_REACHABLE_COMMIT_TREES' } }
  ]);
  const recordedHeadComparison = archive.historicalTreeComparisons.find(item => item.commit === sourceHead);
  assert.equal(recordedHeadComparison.mismatchCount, 51,
    'the reported HEAD is a historical reference, not the exact 92-entry source snapshot');
});

test('all eight immutable dist candidates retain exact hashes and are classified as historical mixed lineage, not assumed corrupt from README drift', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const diagnostic = spawnSync(process.execPath, [path.join(root, 'scripts/diagnose-phase2-archive-lineage.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024
  });
  assert.equal(diagnostic.status, 0, diagnostic.stderr);
  const report = JSON.parse(diagnostic.stdout);
  // The forensic scanner also sees the newly built RC.15 successor. Keep the
  // immutable historical hash assertion scoped to the eight archived legacy
  // candidates; RC.15/RC.16 successors are validated independently by source
  // alignment and must not enter the historical-hash assertion set.
  const historicalArchives = report.archives.filter(archive =>
    !/\/runalith-1\.0\.9-rc\.(?:15|16)-candidate-/.test(archive.path));
  assert.equal(report.frozenContract.expectedArchivePaths, 71);
  assert.equal(report.frozenContract.changed, false);
  assert.equal(report.frozenContract.contractKind, 'frozen-entry-count-only');
  assert.equal(report.frozenContract.authoritativePathListAvailable, false);
  assert.equal(historicalArchives.length, 8);
  const expected = new Map([
    ['dist/runalith-1.0.9-rc.5-candidate-20261019T135338Z.mcpb', ['eb427111586383c45cc1490456cc8a1c781d27fb376e338d1790c07bae95b95b', 49, 12]],
    ['dist/runalith-1.0.9-rc.5-candidate-20261019T152736Z.mcpb', ['c9651c8e46ceb0fc485a33a9d6c34b5d4c35f706aaf9d64697c73db895fcb84d', 51, 11]],
    ['dist/runalith-1.0.9-rc.5-candidate-20261020T084721Z.mcpb', ['df7aca2c5be51738938cd62ab0c37e8957795a324feee17c87cff76f80cfd4c5', 60, 10]],
    ['dist/runalith-1.0.9-rc.5-candidate-20261020T101143Z.mcpb', ['48939e918e32d561e6ef4a74abf96ac42a99a66f44595705207c5f15eb19acf5', 60, 9]],
    ['dist/runalith-1.0.9-rc.5-candidate-20261020T142019Z.mcpb', ['22a2ff82bccc2bb5c3ec7fcf637216e40d90c66d77dfa16fd70177cd7f40a04d', 62, 3]],
    ['dist/runalith-1.0.9-rc.5-candidate-final3-20261019T140521Z.mcpb', ['c474c2225f805cec12433a39c82cf948ebfb8dc3e193bf34824168aaf4297efd', 49, 12]],
    ['dist/runalith-1.0.9-rc.5-candidate-resource-recommender-20261019T-build.mcpb', ['ad5d5118aef07d4a41e687fbc25818d6e6ed40e02dba38ad1f73fdb3a2fc1235', 50, 13]],
    ['dist/runalith-1.0.9-rc.8-candidate-20261026T081256Z.mcpb', ['e1f49add15aaac00fa6924abbf630e41da01e552cf4f1b72639d7eb4b77dd776', 92, 13]],
  ]);
  for (const archive of historicalArchives) {
    const pinned = expected.get(archive.path);
    assert.ok(pinned, `unexpected historical candidate ${archive.path}`);
    assert.equal(archive.sha256, pinned[0], `${archive.path} historical archive hash must remain immutable`);
    assert.equal(archive.archiveEntryCount, pinned[1], `${archive.path} entry count must not be normalized or trimmed`);
    assert.equal(archive.readme.sha256, '94f8e5872363a7288495e24de61e7bff2f5a421e127b8980b5c05357cd9150da',
      `${archive.path} shares the known historical README bytes`);
    assert.equal(archive.sourceLineageClassification, 'historical_readme_drift_plus_mixed_or_unattributed_source_lineage');
    assert.equal(archive.historicalSourceCommitMatchStatus, 'NO_SINGLE_GIT_COMMIT_MATCHES_ALL_PACKAGED_SOURCE_ENTRIES');
    assert.equal(archive.bestHistoricalTreeBySourceEntryMatch.mismatchCount, pinned[2]);
    assert.ok(archive.bestHistoricalTreeBySourceEntryMatch.payloadPathsWithoutReachableGitTreeMatch.length > 0,
      'unreachable historical payload blobs must be surfaced rather than silently attributed to a clean commit');
  }
  assert.deepEqual([...expected.keys()].sort(), historicalArchives.map(archive => archive.path).sort(),
    'the forensic report must account for all and only the eight preserved candidates');
});
