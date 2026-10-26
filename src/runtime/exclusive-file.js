import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Read a bounded, canonical regular file while binding path and descriptor identity. */
export function readStableRegularFile(filePath, { maxBytes = 16 * 1024 * 1024, label = 'Input file' } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) {
    throw new TypeError(`${label} path must be absolute and canonical`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Input byte limit is invalid');
  const beforePath = fs.lstatSync(filePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || fs.realpathSync(filePath) !== filePath || beforePath.size > BigInt(maxBytes)) {
    throw new TypeError(`${label} must be a canonical regular non-symlink file within the byte limit`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.size !== beforePath.size || before.size > BigInt(maxBytes)) {
      throw new Error(`${label} path identity changed before descriptor read`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
      chunks.push(buffer.subarray(0, count));
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || bytes.byteLength !== Number(after.size) ||
        !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.dev !== before.dev || afterPath.ino !== before.ino ||
        afterPath.size !== before.size || afterPath.mtimeNs !== before.mtimeNs || afterPath.ctimeNs !== before.ctimeNs ||
        fs.realpathSync(filePath) !== filePath) throw new Error(`${label} changed during descriptor read`);
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Publish a new file atomically without replacing an existing path on a
 * filesystem that supports same-directory hard links. Bytes are fully written
 * and fsynced to an exclusive sibling temporary file before the complete inode
 * becomes visible at the destination. The parent directory is not fsynced, so
 * this does not promise directory-entry durability across sudden power loss.
 * Path-based ancestor checks narrow symlink escapes but cannot eliminate a
 * hostile same-user rename race without directory-descriptor-relative APIs.
 */
export function writeFileExclusiveAtomic(filePath, data, { mode = 0o600 } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('Output path must be absolute');
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new TypeError('Output mode is invalid');
  if (path.basename(filePath) === '' || path.basename(filePath) === '.' || path.basename(filePath) === '..') {
    throw new TypeError('Output path must name a file');
  }
  // Reject symlinked/non-canonical ancestors rather than trusting only the
  // final parent. This narrows path-escape risk; Node's path-based APIs cannot
  // eliminate a hostile same-user rename race without directory-fd APIs.
  const parentPath = path.dirname(filePath);
  if (path.resolve(parentPath) !== parentPath || fs.realpathSync(parentPath) !== parentPath) {
    throw new TypeError('Output parent must be an existing canonical directory');
  }
  let cursor = path.parse(parentPath).root;
  for (const part of parentPath.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Output parent path must not contain symlinks');
  }
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const temporaryPath = path.join(parentPath, `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`);
  let descriptor = null;
  let published = false;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // link() is atomic and fails with EEXIST; unlike rename(), it never
    // silently replaces a pre-existing output file.
    fs.linkSync(temporaryPath, filePath);
    published = true;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if (error.code !== 'ENOENT') {
        // Never disguise a failed cleanup as success. If publication already
        // happened, the destination contains the complete fsynced inode, but
        // the caller receives an error and must treat the operation as failed.
        error.outputPublished = published;
        throw error;
      }
    }
  }
  return { path: filePath, sizeBytes: bytes.length };
}
