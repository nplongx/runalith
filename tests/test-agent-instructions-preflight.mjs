import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadInstructionBundle } from '../scripts/agent-instructions-preflight.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-agent-preflight-'));
const root = path.join(temp, 'repo');
const globalHome = path.join(temp, 'codex-home');
const outside = path.join(temp, 'outside');
const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

try {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const git = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);

  put(path.join(globalHome, 'AGENTS.md'), 'global base instructions\n');
  put(path.join(globalHome, 'AGENTS.override.md'), 'global override instructions\n');
  put(path.join(root, 'AGENTS.md'), 'root instructions\n');
  put(path.join(root, 'services', 'AGENTS.md'), 'services instructions\n');
  put(path.join(root, 'services', 'payments', 'AGENTS.md'), 'payments base instructions\n');
  put(path.join(root, 'services', 'payments', 'AGENTS.override.md'), 'payments override instructions\n');

  const bundle = loadInstructionBundle({
    cwd: root,
    target: path.join(root, 'services', 'payments'),
    codexHome: globalHome
  });
  assert.deepEqual(bundle.instructions.map(item => item.content.trim()), [
    'global override instructions',
    'root instructions',
    'services instructions',
    'payments override instructions'
  ], 'one non-empty instruction per scope; override wins within its directory');
  assert.equal(bundle.combinedSha256, crypto.createHash('sha256').update(bundle.content).digest('hex'));
  assert.ok(bundle.instructions.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(bundle.instructions.length, 4);

  // Empty overrides are skipped and the same-scope AGENTS.md is used.
  put(path.join(globalHome, 'AGENTS.override.md'), '  \n');
  put(path.join(root, 'services', 'AGENTS.override.md'), '  \n');
  const emptyOverrideBundle = loadInstructionBundle({
    cwd: root,
    target: path.join(root, 'services'),
    codexHome: globalHome
  });
  assert.equal(emptyOverrideBundle.instructions[0].content.trim(), 'global base instructions');
  assert.equal(emptyOverrideBundle.instructions.at(-1).content.trim(), 'services instructions');

  // A directory named AGENTS.override.md is not an instruction file; fall back to AGENTS.md.
  fs.rmSync(path.join(globalHome, 'AGENTS.override.md'));
  fs.mkdirSync(path.join(globalHome, 'AGENTS.override.md'));
  fs.rmSync(path.join(root, 'services', 'AGENTS.override.md'));
  fs.mkdirSync(path.join(root, 'services', 'AGENTS.override.md'));
  const directoryOverrideBundle = loadInstructionBundle({
    cwd: root,
    target: path.join(root, 'services'),
    codexHome: globalHome
  });
  assert.equal(directoryOverrideBundle.instructions[0].content.trim(), 'global base instructions');
  assert.equal(directoryOverrideBundle.instructions.at(-1).content.trim(), 'services instructions');

  assert.throws(() => loadInstructionBundle({
    cwd: root,
    target: outside,
    codexHome: globalHome
  }), /outside Git root/);

  put(path.join(root, 'nested', 'AGENTS.md'), 'x'.repeat(100));
  assert.throws(() => loadInstructionBundle({
    cwd: root,
    target: path.join(root, 'nested'),
    codexHome: globalHome,
    maxBytes: 10
  }), /exceeds maxBytes/);

  put(path.join(outside, 'AGENTS.md'), 'outside instruction\n');
  fs.mkdirSync(path.join(root, 'linked'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'AGENTS.md'), path.join(root, 'linked', 'AGENTS.md'));
  assert.throws(() => loadInstructionBundle({
    cwd: root,
    target: path.join(root, 'linked'),
    codexHome: path.join(temp, 'missing-global')
  }), /symlink escapes project scope/);

  fs.mkdirSync(path.join(root, 'broken-link'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'does-not-exist.md'), path.join(root, 'broken-link', 'AGENTS.md'));
  assert.throws(() => loadInstructionBundle({
    cwd: root,
    target: path.join(root, 'broken-link'),
    codexHome: path.join(temp, 'missing-global')
  }), /cannot read project instruction/);

  const noRootInstructions = path.join(temp, 'empty-repo');
  fs.mkdirSync(noRootInstructions);
  const emptyGit = spawnSync('git', ['init', '--quiet', noRootInstructions], { encoding: 'utf8' });
  assert.equal(emptyGit.status, 0, emptyGit.stderr);
  assert.throws(() => loadInstructionBundle({ cwd: noRootInstructions, target: noRootInstructions, codexHome: path.join(temp, 'missing-global') }), /required project instruction missing/);

  const script = fileURLToPath(new URL('../scripts/agent-instructions-preflight.mjs', import.meta.url));
  const cli = spawnSync(process.execPath, [script, '--target', path.join(root, 'services'), '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: globalHome }
  });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.schema, 'runalith.agent-instructions.v1');
  assert.equal(parsed.gitRoot, fs.realpathSync(root));
  assert.ok(parsed.instructions.some(item => item.scope === 'global'));
  assert.ok(parsed.instructions.some(item => item.path === path.join(root, 'AGENTS.md')));

  console.log('test-agent-instructions-preflight: PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
