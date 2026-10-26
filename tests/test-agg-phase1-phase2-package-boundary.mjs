import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePhase1Phase2PackageBoundary,
  EXPECTED_PHASE1_EXTRA_PATHS,
  EXPECTED_PHASE1_EXTRA_TOOLS
} from '../scripts/verify-agg-phase1-phase2-package-boundary.mjs';

test('RC.5 Phase 1 and Phase 2 package identities remain distinct without weakening the frozen 71-path gate', () => {
  const phase2ArchiveEntries = ['manifest.json', 'server/index.js'];
  for (let i = 0; phase2ArchiveEntries.length < 71; i += 1) {
    phase2ArchiveEntries.push('shared/source-entry-' + String(i).padStart(3, '0') + '.js');
  }
  const phase2ToolNames = Array.from({ length: 59 }, (_, index) => 'shared_tool_' + String(index).padStart(2, '0'));
  const phase1 = {
    relativePath: 'artifacts/phase1-candidate.mcpb',
    sha256: 'a'.repeat(64), sizeBytes: 1000, version: '1.0.9-rc.5',
    archiveEntryCount: 76,
    archiveEntries: [...phase2ArchiveEntries, ...EXPECTED_PHASE1_EXTRA_PATHS],
    manifestSha256: 'b'.repeat(64), manifestToolCount: 67,
    toolNames: [...phase2ToolNames, ...EXPECTED_PHASE1_EXTRA_TOOLS]
  };
  const phase2 = {
    relativePath: 'artifacts/historical-phase2-reference.mcpb',
    sha256: 'c'.repeat(64), sizeBytes: 900, version: '1.0.9-rc.5',
    archiveEntryCount: 71, archiveEntries: phase2ArchiveEntries,
    manifestSha256: 'd'.repeat(64), manifestToolCount: 59, toolNames: phase2ToolNames
  };
  const report = comparePhase1Phase2PackageBoundary(phase1, phase2);
  assert.equal(report.status, 'BLOCKED_PHASE2_FROZEN_COUNT_NOT_APPLICABLE_TO_CURRENT_PHASE1_PACKAGE');
  assert.equal(report.sameSemanticVersionString, true,
    'same RC.5 string does not identify the same package contract');
  assert.equal(report.packageContractsDiffer, true);
  assert.deepEqual(report.pathDelta.phase1Only, [...EXPECTED_PHASE1_EXTRA_PATHS].sort());
  assert.deepEqual(report.pathDelta.phase2Only, []);
  assert.deepEqual(report.toolDelta.phase1Only, [...EXPECTED_PHASE1_EXTRA_TOOLS].sort());
  assert.deepEqual(report.toolDelta.phase2Only, []);
  assert.equal(report.observedBoundaryMatchesFrozenHistoricalShape, true);
  assert.equal(report.frozenPhase2RequiredEntryCount, 71);
  assert.equal(report.phase2ContractChanged, false);
  assert.equal(report.phase1ArchiveTrimmed, false);
  assert.equal(report.phase1CandidateSubstitutedAsPhase2Approval, false);
  assert.equal(report.officialAcceptanceClaimed, false);
});

test('unexpected path/tool deltas cannot masquerade as the recorded historical package boundary', () => {
  const phase2ArchiveEntries = ['manifest.json', 'server/index.js'];
  for (let i = 0; phase2ArchiveEntries.length < 71; i += 1) phase2ArchiveEntries.push('common/' + i + '.js');
  const phase2ToolNames = Array.from({ length: 59 }, (_, i) => 'tool_' + i);
  const phase1 = {
    relativePath: 'phase1.mcpb', sha256: 'a'.repeat(64), sizeBytes: 1000, version: '1.0.9-rc.5',
    archiveEntryCount: 76,
    archiveEntries: [...phase2ArchiveEntries, 'unexpected-extra.js', ...EXPECTED_PHASE1_EXTRA_PATHS.slice(1)],
    manifestSha256: 'b'.repeat(64), manifestToolCount: 67,
    toolNames: [...phase2ToolNames, 'unexpected_extra_tool', ...EXPECTED_PHASE1_EXTRA_TOOLS.slice(1)]
  };
  const phase2 = {
    relativePath: 'phase2.mcpb', sha256: 'c'.repeat(64), sizeBytes: 900, version: '1.0.9-rc.5',
    archiveEntryCount: 71, archiveEntries: phase2ArchiveEntries,
    manifestSha256: 'd'.repeat(64), manifestToolCount: 59, toolNames: phase2ToolNames
  };
  const report = comparePhase1Phase2PackageBoundary(phase1, phase2);
  assert.equal(report.observedBoundaryMatchesFrozenHistoricalShape, false);
});
