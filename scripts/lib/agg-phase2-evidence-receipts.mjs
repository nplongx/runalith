// Exact identity checks for post-publication receipts. These reports live beside
// immutable packs and are intentionally not payload members; only receipts at
// exact derived paths and bound to the exact pack manifest may be excluded.
export function expectedPhase2ExternalChecksumPaths(packRelative) {
  return new Set([
    `${packRelative}/SHA256SUMS.txt`,
    `${packRelative}-pack-verification-final.json`,
    `${packRelative}-final-source-drift-check.json`,
    `${packRelative}-pack-verification-post-sidecar-replay.json`
  ]);
}

export function isBoundEvidenceVerifierReceipt(receipt, { relative, packRelative, manifestSha256 }) {
  const allowedPaths = [
    `${packRelative}-pack-verification-final.json`,
    `${packRelative}-pack-verification-post-sidecar-replay.json`
  ];
  return allowedPaths.includes(relative) &&
    receipt?.kind === 'agg_phase2_evidence_pack_verification' &&
    receipt.pack === packRelative && receipt.manifestSha256 === manifestSha256 &&
    ['VERIFIED', 'BLOCKED'].includes(receipt.verificationStatus) &&
    receipt.acceptanceStatus === 'ACCEPTANCE_REQUIRED' && receipt.executionGate === 'CLOSED';
}

export function isBoundSourceDriftReceipt(receipt, { packRelative, manifestSha256 }) {
  return receipt?.kind === 'agg_phase2_final_source_drift_check' &&
    receipt.pack === packRelative && receipt.manifestSha256 === manifestSha256 &&
    ['PASS', 'FAIL'].includes(receipt.status) && receipt.executionGate === 'CLOSED';
}
