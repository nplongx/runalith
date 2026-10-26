import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep scratch state outside potentially shared/writable repository parents.
// The private SQLite path guard intentionally rejects database paths below a
// non-sticky group/world-writable ancestor; tests should not depend on a repo
// checkout location being safe for durable database storage.
const configuredRoot = os.tmpdir();
// ExecutionManager deliberately places TMPDIR inside a private runtime
// directory and stores immutable, content-addressed executable copies there.
// Tests that create their own nested ExecutionManager must keep independent
// fixture directories OUTSIDE that runtime spool: otherwise each test can pin
// another ~100 MiB Node binary under the spool, compete with the outer task for
// its filesystem quota, and turn a correct test into an execution timeout.
// Production code continues to honour TMPDIR; this helper is test-only.
const executionRuntimeSpool = process.platform === 'linux' && path.basename(path.resolve(configuredRoot)) === 'runtime' &&
  fs.existsSync(path.join(configuredRoot, '.pinned-executables'));
const root = executionRuntimeSpool ? '/tmp' : configuredRoot;
const createdDirectories = new Set();

process.once('exit', code => {
  // Keep failed fixtures available for diagnosis, but automatically reclaim
  // large pinned executables and databases after a successful test process.
  if (code !== 0) return;
  for (const directory of createdDirectories) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});

export function tempDir(prefix = 'test-') {
  const directory = fs.mkdtempSync(path.join(root, prefix));
  createdDirectories.add(directory);
  return directory;
}

export async function tempDirAsync(prefix = 'test-') {
  const { mkdtemp } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(root, prefix));
  createdDirectories.add(directory);
  return directory;
}
