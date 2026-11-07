#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_BYTES = 32 * 1024;
const PROJECT_INSTRUCTION_NAMES = ['AGENTS.override.md', 'AGENTS.md'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveGitRoot(startDirectory) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDirectory,
    encoding: 'utf8',
    timeout: 5000
  });
  if (result.error) throw new Error(`cannot resolve Git root: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`cannot resolve Git root from ${startDirectory}: ${result.stderr.trim() || 'git rev-parse failed'}`);
  return fs.realpathSync(result.stdout.trim());
}

function resolveExistingDirectory(targetPath) {
  const resolved = path.resolve(targetPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error(`target path does not exist or cannot be accessed: ${resolved} (${error.message})`);
  }
  return fs.realpathSync(stat.isDirectory() ? resolved : path.dirname(resolved));
}

function readFirstNonEmptyInstruction(directory, names, scopeRoot, scope) {
  for (const name of names) {
    const candidate = path.join(directory, name);
    try {
      fs.lstatSync(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`cannot inspect ${scope} instruction ${candidate}: ${error.message}`);
    }

    let realPath;
    let stat;
    let content;
    try {
      realPath = fs.realpathSync(candidate);
      stat = fs.statSync(realPath);
      if (stat.isDirectory()) continue;
      if (!stat.isFile()) throw new Error('not a regular file');
      if (!isWithin(scopeRoot, realPath)) {
        throw new Error(`instruction symlink escapes ${scope} scope: ${candidate} -> ${realPath}`);
      }
      content = fs.readFileSync(realPath, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${scope} instruction ${candidate}: ${error.message}`);
    }

    // Codex ignores empty instruction files and falls through to the next name.
    if (content.trim().length === 0) continue;
    return {
      scope,
      path: realPath,
      displayPath: candidate,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, 'utf8'),
      content
    };
  }
  return null;
}

/**
 * Resolve the same primary AGENTS.md chain used by Codex:
 * global override/AGENTS, then one project instruction per directory from
 * Git root to target directory. Unlike silent truncation, this loader fails
 * closed if the effective bundle exceeds maxBytes.
 */
export function loadInstructionBundle({
  cwd = process.cwd(),
  target = cwd,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  maxBytes = DEFAULT_MAX_BYTES,
  gitRoot: explicitGitRoot
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`maxBytes must be a positive safe integer; received ${maxBytes}`);
  }

  const startDirectory = resolveExistingDirectory(cwd);
  const gitRoot = fs.realpathSync(explicitGitRoot || resolveGitRoot(startDirectory));
  const targetDirectory = resolveExistingDirectory(path.resolve(startDirectory, target));
  if (!isWithin(gitRoot, targetDirectory)) {
    throw new Error(`target directory is outside Git root: ${targetDirectory} (root ${gitRoot})`);
  }

  const instructions = [];
  const globalDirectory = path.resolve(codexHome);
  if (fs.existsSync(globalDirectory)) {
    const realGlobalDirectory = fs.realpathSync(globalDirectory);
    const globalInstruction = readFirstNonEmptyInstruction(
      realGlobalDirectory,
      PROJECT_INSTRUCTION_NAMES,
      realGlobalDirectory,
      'global'
    );
    if (globalInstruction) instructions.push(globalInstruction);
  }

  const relativeTarget = path.relative(gitRoot, targetDirectory);
  const projectDirectories = [gitRoot];
  if (relativeTarget) {
    let current = gitRoot;
    for (const segment of relativeTarget.split(path.sep)) {
      current = path.join(current, segment);
      projectDirectories.push(current);
    }
  }

  for (const directory of projectDirectories) {
    const instruction = readFirstNonEmptyInstruction(
      directory,
      PROJECT_INSTRUCTION_NAMES,
      gitRoot,
      'project'
    );
    if (instruction) instructions.push(instruction);
  }

  const rootInstruction = instructions.find(item => item.scope === 'project' && item.displayPath === path.join(gitRoot, 'AGENTS.md'));
  const rootOverride = instructions.find(item => item.scope === 'project' && item.displayPath === path.join(gitRoot, 'AGENTS.override.md'));
  if (!rootInstruction && !rootOverride) {
    throw new Error(`required project instruction missing: ${path.join(gitRoot, 'AGENTS.md')} (or AGENTS.override.md)`);
  }
  if (instructions.length === 0) throw new Error('no non-empty agent instruction files discovered');

  const combinedContent = instructions.map(item => item.content.trimEnd()).join('\n\n');
  const combinedBytes = Buffer.byteLength(combinedContent, 'utf8');
  if (combinedBytes > maxBytes) {
    const breakdown = instructions.map(item => `${item.displayPath}=${item.bytes}`).join(', ');
    throw new Error(`instruction bundle exceeds maxBytes (${combinedBytes} > ${maxBytes}); ${breakdown}`);
  }

  return {
    schema: 'runalith.agent-instructions.v1',
    gitRoot,
    targetDirectory,
    maxBytes,
    combinedBytes,
    combinedSha256: sha256(combinedContent),
    instructions: instructions.map(({ content, ...metadata }) => ({ ...metadata, content })),
    content: combinedContent
  };
}

function parseArgs(argv) {
  const options = { format: 'text', target: process.cwd(), maxBytes: DEFAULT_MAX_BYTES };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--format' || argument.startsWith('--format=')) {
      options.format = argument === '--format' ? argv[++index] : argument.slice('--format='.length);
    } else if (argument === '--target' || argument.startsWith('--target=')) {
      options.target = argument === '--target' ? argv[++index] : argument.slice('--target='.length);
    } else if (argument === '--max-bytes' || argument.startsWith('--max-bytes=')) {
      const value = argument === '--max-bytes' ? argv[++index] : argument.slice('--max-bytes='.length);
      options.maxBytes = Number(value);
    }
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!['text', 'json'].includes(options.format)) throw new Error(`unsupported format: ${options.format}`);
  if (!options.target) throw new Error('--target requires a path');
  return options;
}

function usage() {
  return [
    'Usage: node scripts/agent-instructions-preflight.mjs [options]',
    '',
    'Options:',
    '  --target <path>      Directory or file whose parent directory defines scope (default: cwd)',
    '  --format <text|json> Output format (default: text)',
    '  --max-bytes <n>      Fail if combined instruction content exceeds n bytes (default: 32768)',
    '  --help               Show this help'
  ].join('\n');
}

function renderText(bundle) {
  const output = [
    '# Runalith agent instruction preflight',
    `# Git root: ${bundle.gitRoot}`,
    `# Target: ${bundle.targetDirectory}`,
    `# Combined bytes: ${bundle.combinedBytes}/${bundle.maxBytes}`,
    `# Combined SHA-256: ${bundle.combinedSha256}`
  ];
  for (const instruction of bundle.instructions) {
    output.push('', `<!-- ${instruction.scope}: ${instruction.displayPath} -->`);
    output.push(`<!-- SHA-256: ${instruction.sha256}; bytes: ${instruction.bytes} -->`, '', instruction.content.trimEnd());
  }
  return `${output.join('\n')}\n`;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const bundle = loadInstructionBundle({ target: options.target, maxBytes: options.maxBytes });
    process.stdout.write(options.format === 'json'
      ? `${JSON.stringify(bundle, null, 2)}\n`
      : renderText(bundle));
  } catch (error) {
    process.stderr.write(`agent-instructions-preflight: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
