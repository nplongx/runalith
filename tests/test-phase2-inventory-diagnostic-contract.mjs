import test from 'node:test';
import assert from 'node:assert/strict';
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
