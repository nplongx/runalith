import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_TOP_LEVEL = new Set(['server', 'src', 'tests', 'docs', 'benchmarks', 'scripts', 'plugin', 'protocol']);
const MAX_SOURCE_BYTES = 1024 * 1024;

function evidenceReferenceError(code, message) {
  return Object.assign(new TypeError(message), { code });
}

/**
 * Collect references without silently dropping malformed step fields. This is
 * input-shape validation only: returned references remain unverified until
 * the durable artifact/source resolvers independently inspect them.
 */
export function collectAdaptiveGoalEvidenceReferences(draft) {
  if (!draft || !Array.isArray(draft.steps) || draft.steps.length < 1 || draft.steps.length > 500) {
    throw evidenceReferenceError('SOURCE_DRAFT_INVALID', 'Plan Graph draft must contain a bounded non-empty action-step array');
  }
  const references = [];
  for (const [index, step] of draft.steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step) || !Array.isArray(step.supportingEvidenceRefs)) {
      throw evidenceReferenceError('EVIDENCE_REFERENCE_INVALID', `Plan Graph step ${index} must explicitly provide a supportingEvidenceRefs array`);
    }
    if (step.supportingEvidenceRefs.length > 512 || references.length + step.supportingEvidenceRefs.length > 2048) {
      throw evidenceReferenceError('EVIDENCE_REFERENCE_LIMIT_EXCEEDED', 'Plan Graph raw evidence references exceed the bounded resolver limit');
    }
    for (const reference of step.supportingEvidenceRefs) {
      if (typeof reference !== 'string' || !reference.trim() || reference.length > 512) {
        throw evidenceReferenceError('EVIDENCE_REFERENCE_INVALID', 'Plan Graph evidence references must be non-empty strings up to 512 characters; malformed references cannot be silently dropped');
      }
      references.push(reference);
    }
  }
  return references;
}

// Do not let a file that grows after fstat turn a nominally bounded source
// read into an unbounded allocation. Read at most the policy limit plus one
// sentinel byte; the caller compares descriptor/path metadata before and after
// the read and refuses to promote a changed source.
function readBoundedDescriptor(fd, maxBytes, expectedSize) {
  const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, expectedSize + 1));
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

function status(reference, classification, extra = {}) {
  return { reference, classification, integrityVerified: false, claimVerified: false, independenceVerified: false, ...extra };
}

function canonicalRegularFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative)) return null;
  const parts = relative.split('/');
  if (!ALLOWED_TOP_LEVEL.has(parts[0]) || parts.some(part => !part || part === '.' || part === '..')) return null;
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    let info;
    try { info = fs.lstatSync(cursor); } catch { return null; }
    if (info.isSymbolicLink()) return null;
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) return null;
  }
  try {
    if (fs.realpathSync(cursor) !== cursor) return null;
  } catch { return null; }
  return cursor;
}

/**
 * Verify the integrity of explicitly content-addressed local source references.
 * This proves only that current local file bytes match the supplied digest; it
 * does not prove that a claim is true, that the source is independent, or that
 * a runtime event occurred. No file body is returned, executed, or written.
 */
export function resolveAdaptiveGoalSourceEvidence(references, { root } = {}) {
  if (!Array.isArray(references) || references.length > 2048 || references.some(ref =>
    typeof ref !== 'string' || !ref.trim() || ref.length > 512)) {
    throw new TypeError('source evidence references must be a bounded array of non-empty strings up to 512 characters');
  }
  if (new Set(references).size !== references.length) {
    throw new TypeError('source evidence references must not contain duplicates');
  }
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('source evidence root must be an absolute path');
  const canonicalRoot = fs.realpathSync(root);
  if (canonicalRoot !== root) throw new TypeError('source evidence root must be canonical');
  const unique = [...references].sort();
  return unique.map(reference => {
    if (/^(placeholder|todo|tbd|collect|missing):/i.test(reference)) {
      return status(reference, 'placeholder_not_evidence');
    }
    const match = /^file:([^#\s]+)#sha256=([a-f0-9]{64})$/.exec(reference);
    if (!match) return status(reference, 'not_content_addressed');
    const [, relative, expectedHash] = match;
    const filePath = canonicalRegularFile(canonicalRoot, relative);
    if (!filePath) return status(reference, 'source_unavailable_or_out_of_scope');
    let bytes;
    let stableStat;
    let identityChanged = false;
    try {
      const beforePath = fs.lstatSync(filePath, { bigint: true });
      if (!beforePath.isFile() || beforePath.isSymbolicLink() || fs.realpathSync(filePath) !== filePath) {
        return status(reference, 'source_unavailable_or_out_of_scope');
      }
      const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
          identityChanged = true;
        } else if (before.size > BigInt(MAX_SOURCE_BYTES)) {
          return status(reference, 'source_size_limit_exceeded', { sizeBytes: Number(before.size), maxBytes: MAX_SOURCE_BYTES });
        } else {
          bytes = readBoundedDescriptor(fd, MAX_SOURCE_BYTES, Number(before.size));
          const after = fs.fstatSync(fd, { bigint: true });
          const afterPath = fs.lstatSync(filePath, { bigint: true });
          identityChanged = bytes.length > MAX_SOURCE_BYTES || !after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
            after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
            !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.dev !== before.dev || afterPath.ino !== before.ino ||
            afterPath.size !== before.size || afterPath.mtimeNs !== before.mtimeNs || afterPath.ctimeNs !== before.ctimeNs ||
            fs.realpathSync(filePath) !== filePath;
          stableStat = before;
        }
      } finally { fs.closeSync(fd); }
    } catch { return status(reference, identityChanged ? 'source_changed_during_read' : 'source_read_failed'); }
    if (identityChanged || !bytes || !stableStat) return status(reference, 'source_changed_during_read');
    const observedHash = createHash('sha256').update(bytes).digest('hex');
    return {
      reference,
      classification: observedHash === expectedHash ? 'source_bytes_verified_claim_unverified' : 'source_hash_mismatch',
      integrityVerified: observedHash === expectedHash,
      claimVerified: false,
      path: relative,
      expectedSha256: expectedHash,
      observedSha256: observedHash,
      sizeBytes: Number(stableStat.size),
      modifiedAt: new Date(Number(stableStat.mtimeNs / 1_000_000n)).toISOString(),
      independenceVerified: false
    };
  });
}
