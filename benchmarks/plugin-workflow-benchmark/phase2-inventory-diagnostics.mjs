// Stable, machine-readable diagnosis for independent Phase 2 inventory blockers.
// These classifications do not authorize changing the frozen 71-entry contract.
export const FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT = 71;

export function classifyPhase2CandidateFailure(output) {
  const text = String(output || '');
  // Stack traces also print the source-code template literal containing ${name};
  // classify using the final runtime error occurrence, not that earlier source line.
  const mismatches = [...text.matchAll(/source\/archive bytes differ for ([^;]+);/g)];
  const mismatch = mismatches.at(-1);
  if (mismatch) {
    const entry = mismatch[1].replace(/^['"]|['"]$/g, '');
    return {
      classification: entry === 'manifest.json'
        ? 'historical_source_manifest_lineage_mismatch'
        : 'archive_payload_source_mismatch',
      firstMismatchedEntry: entry
    };
  }
  if (/unsafe entry paths/.test(text)) return { classification: 'unsafe_archive_path', firstMismatchedEntry: null };
  if (/source path is missing or contains a symlink/.test(text)) return { classification: 'source_path_symlink_or_missing', firstMismatchedEntry: null };
  if (/bundle path/.test(text)) return { classification: 'candidate_path_invalid', firstMismatchedEntry: null };
  return { classification: 'candidate_inventory_rejected', firstMismatchedEntry: null };
}

export function diagnosePhase2EntryCount(observed) {
  if (!Number.isSafeInteger(observed) || observed < 0) throw new TypeError('observed Phase 2 archive entry count must be a non-negative safe integer');
  return Object.freeze({
    classification: observed === FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT
      ? 'frozen_inventory_count_match'
      : 'frozen_inventory_count_mismatch',
    expectedFrozenEntryCount: FROZEN_PHASE2_ARCHIVE_ENTRY_COUNT,
    observedEntryCount: observed,
    acceptanceContractChanged: false
  });
}
