#!/usr/bin/env node
/**
 * Read-only forensic aid for historical Phase-2 candidate archives.
 *
 * This reports content correspondence only. A matching Git blob/commit does
 * not authenticate the archive builder, prove the source tree was clean, or
 * establish approval. It never writes inventories or changes the frozen
 * 71-path acceptance contract.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafePortableArchivePath } from '../benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const args = [];
const explicitSourceCommits = [];
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '--help') {
    console.log('Usage: node scripts/diagnose-phase2-archive-lineage.mjs [--source-commit <git-ref> ...] [archive.mcpb ...]\n' +
      'Without archive paths, inspect dist/runalith-*-candidate-*.mcpb. Explicit commits are compared even if README differs. ' +
      'Read-only; content correspondence is not authenticated provenance or approval.');
    process.exit(0);
  }
  if (argv[index] === '--source-commit') {
    const ref = argv[++index];
    if (!ref || ref.startsWith('--')) throw new Error('--source-commit requires a Git ref or commit ID');
    explicitSourceCommits.push(ref);
  } else if (argv[index].startsWith('--')) throw new Error(`unsupported argument: ${argv[index]}`);
  else args.push(argv[index]);
}
let defaultCandidateNames = [];
if (!args.length) {
  try {
    defaultCandidateNames = fs.readdirSync(path.join(root, 'dist'))
      .filter(name => /^runalith-.*-candidate-.*\.mcpb$/.test(name));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause;
  }
}
const candidates = args.length ? args.map(value => path.resolve(root, value)) :
  defaultCandidateNames.map(name => path.join(root, 'dist', name)).sort();
if (!candidates.length) {
  console.error('No candidate archives found. Supply an archive path or restore the historical dist candidates.');
  process.exit(2);
}

function runGit(args, input) {
  return execFileSync('git', args, { cwd: root, input, encoding: input === undefined ? 'utf8' : undefined,
    maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function gitBlobSha1(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
const gitObjectTypeCache = new Map();
function gitObjectPresence(oid, reachableCommitBlobMatchCount) {
  let type;
  if (gitObjectTypeCache.has(oid)) {
    type = gitObjectTypeCache.get(oid);
  } else {
    try {
      type = runGit(['cat-file', '-t', oid]).trim();
      gitObjectTypeCache.set(oid, type);
    } catch {
      gitObjectTypeCache.set(oid, null);
      type = null;
    }
  }
  if (type) return {
    objectPresent: true,
    objectType: type,
    reachability: reachableCommitBlobMatchCount > 0 ? 'REACHABLE_FROM_COMMIT_TREE' : 'NOT_FOUND_IN_REACHABLE_COMMIT_TREES',
  };
  return { objectPresent: false, objectType: null, reachability: 'OBJECT_NOT_PRESENT_IN_LOCAL_GIT_DATABASE' };
}
function treeFor(commit) {
  const raw = runGit(['ls-tree', '-r', '-z', '--full-tree', commit]);
  const tree = new Map();
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    tree.set(record.slice(tab + 1), { mode, type, oid });
  }
  return tree;
}
let historicalTrees;
let allGitTreeBlobCounts;
let reachablePathBlobCommits;
function commitsContainingPathBlob() {
  if (reachablePathBlobCommits) return reachablePathBlobCommits;
  // `treesWithReadmeBlob` initializes this list from `git rev-list --all`.
  // Index exact (path, blob OID) pairs once so the per-path report can identify
  // custody independently of README lineage or the best-scoring candidate tree.
  if (!historicalTrees) {
    historicalTrees = runGit(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean)
      .map(commit => ({ commit, tree: treeFor(commit) }));
  }
  reachablePathBlobCommits = new Map();
  for (const { commit, tree } of historicalTrees) {
    for (const [sourcePath, blob] of tree) {
      if (blob.type !== 'blob') continue;
      const key = `${sourcePath}\0${blob.oid}`;
      const commits = reachablePathBlobCommits.get(key) || [];
      commits.push(commit);
      reachablePathBlobCommits.set(key, commits);
    }
  }
  return reachablePathBlobCommits;
}
function blobOccurrencesAcrossAllGitTrees() {
  if (allGitTreeBlobCounts) return allGitTreeBlobCounts;
  allGitTreeBlobCounts = new Map();
  const objects = runGit(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'])
    .trim().split(/\r?\n/).filter(Boolean);
  for (const record of objects) {
    const [oid, type] = record.split(' ');
    if (type !== 'tree') continue;
    const raw = runGit(['ls-tree', '-r', '-z', '--full-tree', oid]);
    for (const item of raw.split('\0')) {
      if (!item) continue;
      const tab = item.indexOf('\t');
      const [mode, objectType, blobOid] = item.slice(0, tab).split(' ');
      const sourcePath = item.slice(tab + 1);
      if (objectType !== 'blob') continue;
      const key = `${sourcePath}\0${blobOid}`;
      allGitTreeBlobCounts.set(key, (allGitTreeBlobCounts.get(key) || 0) + 1);
    }
  }
  return allGitTreeBlobCounts;
}
function treesWithReadmeBlob(blobOid) {
  if (!historicalTrees) {
    historicalTrees = [];
    const commits = runGit(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean);
    for (const commit of commits) {
      const tree = treeFor(commit);
      historicalTrees.push({ commit, tree });
    }
  }
  return historicalTrees.filter(({ tree }) => tree.get('README.md')?.oid === blobOid);
}
function explicitTrees() {
  return explicitSourceCommits.map(ref => {
    const commit = runGit(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    return { commit, requestedRef: ref, tree: treeFor(commit) };
  });
}
function readArchive(archive) {
  const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const paths = listing.split(/\r?\n/).filter(Boolean);
  const seen = new Set();
  for (const name of paths) {
    if (!isSafePortableArchivePath(name) || seen.has(name)) throw new Error(`unsafe or duplicate archive path: ${name}`);
    seen.add(name);
  }
  return paths.filter(name => !name.endsWith('/')).map(name => ({
    name,
    bytes: execFileSync('unzip', ['-p', archive, name], { maxBuffer: 64 * 1024 * 1024 }),
  }));
}
function sourcePathFor(name) {
  if (name === 'manifest.json') return 'plugin/manifest.json';
  return name;
}
function currentSourceBytes(name) {
  // package.json is a generated runtime-metadata projection and is diagnosed
  // separately; do not misrepresent it as exact source bytes.
  if (name === 'package.json') return { kind: 'generated_projection', bytes: null };
  const source = path.resolve(root, sourcePathFor(name));
  if (!source.startsWith(`${root}${path.sep}`) || !fs.existsSync(source)) return { kind: 'missing', bytes: null };
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: 'unsafe_source', bytes: null };
  return { kind: 'source', bytes: fs.readFileSync(source) };
}

const report = {
  schemaVersion: 2,
  diagnosticOnly: true,
  frozenContract: {
    expectedArchivePaths: 71,
    changed: false,
    contractKind: 'frozen-entry-count-only',
    authoritativePathListAvailable: false,
    contractDefinitionPath: 'benchmarks/plugin-workflow-benchmark/phase2-inventory-diagnostics.mjs',
    contractDefinitionCommit: 'ffee0815b8dfcac21d15d8eaeaf1d309aab2b7e2',
    note: 'The checked-in acceptance contract freezes cardinality, not a canonical 71-path manifest. A path-level canonical snapshot cannot be reconstructed from this count alone.'
  },
  references: { currentHead: runGit(['rev-parse', 'HEAD']).trim(), originMain: runGit(['rev-parse', 'origin/main']).trim(),
    rc11TagCommit: runGit(['rev-parse', 'v1.0.9-rc.11^{commit}']).trim(),
    explicitSourceCommits: explicitTrees().map(({ commit, requestedRef }) => ({ requestedRef, commit })) },
  archives: []
};

for (const archive of candidates) {
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`candidate must be a regular non-symlink file: ${archive}`);
  const archiveBytes = fs.readFileSync(archive);
  const entries = readArchive(archive);
  const readme = entries.find(entry => entry.name === 'README.md');
  if (!readme) throw new Error(`candidate is missing README.md: ${archive}`);
  // The manifest is exact source content at plugin/manifest.json. Only the
  // local-runtime package.json is a generated projection rather than a source
  // file, and is excluded from source-blob scoring.
  const tracked = entries.filter(entry => entry.name !== 'package.json');
  const currentMismatches = [];
  const perPathProvenance = [];
  for (const entry of tracked) {
    const current = currentSourceBytes(entry.name);
    if (current.kind !== 'source') currentMismatches.push({ path: entry.name, reason: current.kind });
    else if (!current.bytes.equals(entry.bytes)) currentMismatches.push({ path: entry.name, reason: 'byte_mismatch',
      archiveSha256: sha256(entry.bytes), currentSha256: sha256(current.bytes) });
    const sourcePath = sourcePathFor(entry.name);
    const archiveGitBlobSha1 = gitBlobSha1(entry.bytes);
    const matchingCommits = commitsContainingPathBlob().get(`${sourcePath}\0${archiveGitBlobSha1}`) || [];
    const object = gitObjectPresence(archiveGitBlobSha1, matchingCommits.length);
    perPathProvenance.push({
      archivePath: entry.name,
      sourcePath,
      archiveSizeBytes: entry.bytes.length,
      archiveSha256: sha256(entry.bytes),
      archiveGitBlobSha1,
      currentSourceClassification: current.kind === 'source'
        ? (current.bytes.equals(entry.bytes) ? 'exact_current_source_bytes' : 'current_source_bytes_differ')
        : `current_source_${current.kind}`,
      ...(current.kind === 'source' ? { currentSourceSha256: sha256(current.bytes) } : {}),
      reachableGitTreeCommitCount: matchingCommits.length,
      reachableGitTreeCommits: matchingCommits,
      gitObjectDatabase: object,
      custodyClassification: matchingCommits.length > 0
        ? 'exact_path_blob_observed_in_reachable_git_commit_tree'
        : object.objectPresent
          ? 'blob_object_present_but_no_reachable_commit_tree_contains_exact_path_blob'
          : 'blob_object_not_present_in_local_git_database'
    });
  }

  // Search repository history for commits with the exact archived README blob,
  // then compare every other packaged source path against each such tree.
  const readmeBlob = gitBlobSha1(readme.bytes);
  const matchingReadmeCommits = treesWithReadmeBlob(readmeBlob);
  const candidateTrees = [...matchingReadmeCommits, ...explicitTrees()]
    .filter((item, index, all) => all.findIndex(other => other.commit === item.commit) === index);
  const historicalComparisons = candidateTrees.map(({ commit, tree, requestedRef }) => {
    const mismatches = [];
    let matched = 0;
    for (const entry of tracked) {
      const sourcePath = sourcePathFor(entry.name);
      const blob = tree.get(sourcePath);
      const entryBlob = gitBlobSha1(entry.bytes);
      if (blob?.type === 'blob' && blob.oid === entryBlob) matched++;
      else {
        const reachableCommitBlobMatchCount = historicalTrees.filter(item => item.tree.get(sourcePath)?.type === 'blob' &&
          item.tree.get(sourcePath).oid === entryBlob).length;
        const allGitTreeBlobMatchCount = blobOccurrencesAcrossAllGitTrees().get(`${sourcePath}\0${entryBlob}`) || 0;
        mismatches.push({
          path: entry.name,
          reason: !blob ? 'path_absent_at_commit' : 'blob_differs_at_commit',
          archiveSha256: sha256(entry.bytes),
          archiveGitBlobSha1: entryBlob,
          commitBlobOid: blob?.type === 'blob' ? blob.oid : null,
          reachableCommitBlobMatchCount,
          allGitTreeBlobMatchCount,
          gitObjectDatabase: gitObjectPresence(entryBlob, reachableCommitBlobMatchCount),
        });
      }
    }
    return { commit, ...(requestedRef ? { requestedRef } : {}), exactSourceEntryMatches: matched, comparedSourceEntries: tracked.length,
      firstMismatches: mismatches.slice(0, 12), mismatchCount: mismatches.length,
      payloadPathsWithoutReachableGitTreeMatch: mismatches.filter(item =>
        item.gitObjectDatabase?.reachability === 'NOT_FOUND_IN_REACHABLE_COMMIT_TREES').map(item => item.path) };
  }).sort((a, b) => b.exactSourceEntryMatches - a.exactSourceEntryMatches || a.commit.localeCompare(b.commit));

  const bestHistorical = historicalComparisons[0] || null;
  const archivedReadmeExistsInHistory = matchingReadmeCommits.length > 0;
  const unmatchedHistoricalPayloadPaths = bestHistorical?.payloadPathsWithoutReachableGitTreeMatch || [];
  // A current-source byte mismatch is not, by itself, proof that the archive
  // is corrupt. Preserve the distinction between known historical README
  // drift, a mixed/uncommitted source snapshot, and bytes not attributable to
  // any Git blob in this repository's object database.
  let sourceLineageClassification;
  if (bestHistorical?.mismatchCount === 0) sourceLineageClassification = 'exact_git_commit_content_match';
  else if (!archivedReadmeExistsInHistory && unmatchedHistoricalPayloadPaths.length) {
    sourceLineageClassification = 'unattributed_payload_bytes_possible_corruption_or_external_source';
  } else if (archivedReadmeExistsInHistory && bestHistorical && bestHistorical.mismatchCount > 0) {
    sourceLineageClassification = unmatchedHistoricalPayloadPaths.length
      ? 'historical_readme_drift_plus_mixed_or_unattributed_source_lineage'
      : 'historical_readme_drift_plus_mixed_source_lineage';
  } else sourceLineageClassification = 'source_lineage_unresolved';

  report.archives.push({
    path: path.relative(root, archive).split(path.sep).join('/'),
    bytes: archiveBytes.length,
    sha256: sha256(archiveBytes),
    archiveEntryCount: entries.length,
    readme: { bytes: readme.bytes.length, sha256: sha256(readme.bytes), gitBlobSha1: readmeBlob,
      matchingGitCommitCount: matchingReadmeCommits.length,
      matchingGitCommits: matchingReadmeCommits.map(({ commit }) => commit) },
    currentWorktree: { comparedSourceEntries: tracked.length, mismatchCount: currentMismatches.length,
      firstMismatches: currentMismatches.slice(0, 12) },
    perPathProvenance,
    bestHistoricalTreeBySourceEntryMatch: [...historicalComparisons].sort((a, b) =>
      b.exactSourceEntryMatches - a.exactSourceEntryMatches || a.commit.localeCompare(b.commit))[0] || null,
    bestHistoricalTreeByReadmeLineage: historicalComparisons.filter(item => matchingReadmeCommits.some(match => match.commit === item.commit))
      .sort((a, b) => b.exactSourceEntryMatches - a.exactSourceEntryMatches || a.commit.localeCompare(b.commit))[0] || null,
    historicalTreeComparisons: historicalComparisons,
    generatedEntries: entries.filter(entry => entry.name === 'package.json').map(entry => ({
      path: entry.name, bytes: entry.bytes.length, sha256: sha256(entry.bytes), comparison: 'generated runtime metadata projection; excluded from exact source-blob score'
    })),
    historicalSourceCommitMatchStatus: historicalComparisons.some(item => item.mismatchCount === 0)
      ? 'EXACT_SOURCE_COMMIT_CONTENT_MATCH_FOUND'
      : 'NO_SINGLE_GIT_COMMIT_MATCHES_ALL_PACKAGED_SOURCE_ENTRIES',
    sourceLineageClassification,
    sourceLineageInterpretation: sourceLineageClassification === 'historical_readme_drift_plus_mixed_source_lineage'
      ? 'README is a known historical Git blob, but no single candidate Git tree matches all archived source entries; this supports source drift/mixed snapshot, not archive corruption by itself.'
      : sourceLineageClassification === 'historical_readme_drift_plus_mixed_or_unattributed_source_lineage'
        ? 'README is historical, while one or more compared payload blobs are absent from the local Git object database; mixed source lineage is established and those bytes remain unattributed, not proven corrupt.'
        : sourceLineageClassification === 'unattributed_payload_bytes_possible_corruption_or_external_source'
          ? 'No historical README blob match and one or more payload blobs are unattributed; corruption versus external source cannot be decided from local evidence.'
          : sourceLineageClassification === 'exact_git_commit_content_match'
            ? 'All compared source entries match one Git commit tree; build authenticity and approval remain unproven.'
            : 'Available local Git evidence does not resolve source lineage.',
    unmatchedHistoricalPayloadPaths,
    requiredMissingEvidence: [
      'authenticated source snapshot or build receipt binding this exact archive SHA-256 to a source tree',
      'independently authenticated builder identity and source-tree cleanliness/dirty-diff evidence',
      'independent release approval and production authority evidence'
    ],
    conclusion: 'content correspondence only; archive builder provenance, clean-tree state, signatures, approvals, and claim truth are not established'
  });
}

console.log(JSON.stringify(report, null, 2));
