import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAutomaticSendCheckServer, evaluateAutomaticSend } from '../scripts/cos-automatic-send-check.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-cos-send-check-'));
const root = path.join(temp, 'repo');
const otherRoot = path.join(temp, 'other-repo');
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const initGit = directory => {
  fs.mkdirSync(directory, { recursive: true });
  const result = spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const validRequest = overrides => ({
  version: 1,
  kind: 'continue',
  id: 'automatic-send-123',
  chat: { session: null, project: null, worker: null },
  text: 'Continue the unfinished implementation.',
  attempt: 1,
  ...overrides
});
const codeGraphInstructions = [
  'Before every repository source query or source retrieval, run `codegraph sync` from the Git root and require a successful completion with the index up to date.',
  'After changing source files, run `codegraph sync` again before the next source query.',
  'If CodeGraph is unavailable or sync fails, stop source-query work and report the blocker.'
].join('\n');
const successfulCodeGraphSync = rootPath => ({ status: 0, stdout: `CodeGraph synced ${rootPath}`, stderr: '' });

try {
  initGit(root);
  write(path.join(root, 'AGENTS.md'), `# Required repo instructions\nUse test-first implementation.\n${codeGraphInstructions}\n`);
  write(path.join(root, 'src', 'runtime', 'AGENTS.md'), '# Runtime instructions\nPreserve fail-closed semantics.\n');
  initGit(otherRoot);
  write(path.join(otherRoot, 'AGENTS.md'), `# Other project instructions\n${codeGraphInstructions}\n`);

  const syncedRoots = [];
  const good = evaluateAutomaticSend(validRequest(), {
    root,
    target: 'src/runtime',
    codegraphSync: rootPath => { syncedRoots.push(rootPath); return successfulCodeGraphSync(rootPath); }
  });
  assert.equal(good.allow, true);
  assert.equal(good.preflight.root, fs.realpathSync(root));
  assert.equal(good.preflight.instructionCount, 2);
  assert.match(good.preflight.combinedSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(syncedRoots, [fs.realpathSync(root)]);
  assert.equal(good.preflight.codegraph.status, 'synced');

  const badKinds = evaluateAutomaticSend(validRequest({ kind: 'future-unreviewed-kind' }), { root });
  assert.equal(badKinds.allow, false);
  assert.match(badKinds.reason, /unsupported automatic-send kind/);

  const badVersion = evaluateAutomaticSend(validRequest({ version: 2 }), { root });
  assert.equal(badVersion.allow, false);
  assert.match(badVersion.reason, /protocol version/);

  const missingChatMember = evaluateAutomaticSend(validRequest({ chat: {} }), { root });
  assert.equal(missingChatMember.allow, false);
  assert.match(missingChatMember.reason, /chat\.session is missing/);

  const noInstructions = evaluateAutomaticSend(validRequest(), { root: otherRoot, target: 'missing' });
  assert.equal(noInstructions.allow, false);
  assert.match(noInstructions.reason, /preflight blocked/);

  const noDefaultPolicy = path.join(temp, 'policy-no-default.json');
  write(noDefaultPolicy, JSON.stringify({ version: 1, default: null, sessions: {}, projects: {}, workers: {} }));
  const unmapped = evaluateAutomaticSend(validRequest(), { root, policyPath: noDefaultPolicy });
  assert.equal(unmapped.allow, false);
  assert.match(unmapped.reason, /no repository mapping/);

  const mappedPolicy = path.join(temp, 'policy-mapped.json');
  write(mappedPolicy, JSON.stringify({
    version: 1,
    sessions: { 'session-runtime': { root, target: 'src/runtime' } },
    projects: { 'project-other': { root: otherRoot, target: '.' } },
    workers: {},
  }));
  const mapped = evaluateAutomaticSend(validRequest({ chat: { session: 'session-runtime', project: null, worker: null } }), {
    policyPath: mappedPolicy,
    codegraphSync: successfulCodeGraphSync
  });
  assert.equal(mapped.allow, true);
  assert.equal(mapped.preflight.matchedBy, 'session');
  const mappedProject = evaluateAutomaticSend(validRequest({ chat: { session: null, project: 'project-other', worker: null } }), {
    policyPath: mappedPolicy,
    codegraphSync: () => ({ status: 1, stdout: '', stderr: 'mapped repository index is stale' })
  });
  assert.equal(mappedProject.allow, false, 'mapped repositories must pass CodeGraph sync too');
  assert.match(mappedProject.reason, /CodeGraph sync blocked/);

  const noCodeGraphRoot = path.join(temp, 'repo-without-codegraph-instructions');
  initGit(noCodeGraphRoot);
  write(path.join(noCodeGraphRoot, 'AGENTS.md'), '# Required repo instructions\nUse test-first implementation.\n');
  let syncAttemptedWithoutRule = false;
  const missingCodeGraphRule = evaluateAutomaticSend(validRequest(), {
    root: noCodeGraphRoot,
    codegraphSync: rootPath => { syncAttemptedWithoutRule = true; return successfulCodeGraphSync(rootPath); }
  });
  assert.equal(missingCodeGraphRule.allow, false);
  assert.match(missingCodeGraphRule.reason, /CodeGraph instruction gate is missing/);
  assert.equal(syncAttemptedWithoutRule, false, 'do not sync or allow when the instruction bundle omits the CodeGraph gate');

  const incompleteCodeGraphRoot = path.join(temp, 'repo-with-incomplete-codegraph-instructions');
  initGit(incompleteCodeGraphRoot);
  write(path.join(incompleteCodeGraphRoot, 'AGENTS.md'), [
    '# Incomplete CodeGraph instructions',
    'Before every repository source query or source retrieval, run `codegraph sync`.',
    'If CodeGraph is unavailable or sync fails, stop source-query work and report the blocker.'
  ].join('\n'));
  const incompleteCodeGraphRule = evaluateAutomaticSend(validRequest(), { root: incompleteCodeGraphRoot });
  assert.equal(incompleteCodeGraphRule.allow, false);
  assert.match(incompleteCodeGraphRule.reason, /CodeGraph instruction gate is missing or incomplete/);

  const failedCodeGraphSync = evaluateAutomaticSend(validRequest(), {
    root,
    codegraphSync: () => ({ status: 1, stdout: '', stderr: 'index lock unavailable' })
  });
  assert.equal(failedCodeGraphSync.allow, false);
  assert.match(failedCodeGraphSync.reason, /CodeGraph sync blocked/);
  assert.match(failedCodeGraphSync.reason, /index lock unavailable/);

  const unavailableCodeGraph = evaluateAutomaticSend(validRequest(), {
    root,
    codegraphSync: () => { throw new Error('spawn codegraph ENOENT'); }
  });
  assert.equal(unavailableCodeGraph.allow, false);
  assert.match(unavailableCodeGraph.reason, /CodeGraph sync blocked/);
  assert.match(unavailableCodeGraph.reason, /ENOENT/);

  const httpSyncRoots = [];
  const server = createAutomaticSendCheckServer({
    root,
    target: 'src/runtime',
    port: 0,
    codegraphSync: rootPath => { httpSyncRoots.push(rootPath); return successfulCodeGraphSync(rootPath); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const allowed = await fetch(`http://127.0.0.1:${address.port}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest())
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { allow: true });
    assert.deepEqual(httpSyncRoots, [fs.realpathSync(root)]);

    const held = await fetch(`http://127.0.0.1:${address.port}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest({ kind: 'unknown-kind' }))
    });
    assert.equal(held.status, 200);
    const heldBody = await held.json();
    assert.equal(heldBody.allow, false);
    assert.ok(heldBody.reason);

    const wrongMethod = await fetch(`http://127.0.0.1:${address.port}/check`);
    assert.equal(wrongMethod.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  assert.throws(() => createAutomaticSendCheckServer({ host: '0.0.0.0' }), /loopback only/);
  console.log('test-cos-automatic-send-check: PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
