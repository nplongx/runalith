#!/usr/bin/env node
/**
 * Read-only source inventory for WorkflowStore.recordEvent() callers.
 *
 * This is a drift-discovery aid, not an authorization-event allowlist. It does
 * not open SQLite, infer deployed workers, or establish which optional modules
 * are active in production. Output files are created exclusively (never
 * overwritten) when --output is supplied.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Build a same-length executable-code view. Strings/comments/regex bodies and
// template raw text become spaces, while `${ ... }` expressions stay visible.
// This is deliberately a bounded lexer for discovery, not a JS parser.
function executableCodeView(source) {
  const view = Array.from(source, ch => ch === '\n' || ch === '\r' ? ch : ' ');
  const keywordsAllowingRegex = new Set([
    'await', 'break', 'case', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
    'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield'
  ]);
  const mark = (start, end) => {
    for (let i = start; i < end; i++) if (source[i] !== '\n' && source[i] !== '\r') view[i] = source[i];
  };
  const scanTemplate = start => {
    let i = start + 1;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '`') return i + 1;
      if (source[i] === '$' && source[i + 1] === '{') {
        i = scanCode(i + 2, true);
        continue;
      }
      i++;
    }
    return source.length;
  };
  const scanRegex = start => {
    let i = start + 1;
    let inClass = false;
    while (i < source.length) {
      const ch = source[i++];
      if (ch === '\\') { i++; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      else if (ch === '\n' || ch === '\r') return i - 1;
    }
    while (/[A-Za-z]/.test(source[i] || '')) i++;
    return i;
  };
  const nextSignificantCharacter = start => {
    let i = start;
    while (i < source.length) {
      if (/\s/.test(source[i])) { i++; continue; }
      if (source.startsWith('//', i)) {
        i += 2; while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
        continue;
      }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      return source[i];
    }
    return '';
  };
  const scanCode = (start, stopAtBrace = false) => {
    let i = start;
    let braceDepth = 0;
    const braceKinds = [];
    const controlParens = [];
    let regexAllowed = true;
    let previousToken = '';
    let classDeclarationPending = false;
    let statementStart = true;
    let labelColonPending = false;
    let caseColonPending = false;
    let blockAfterColonPending = false;
    let switchKeywordPending = false;
    let switchBlockPending = false;
    let switchDepth = 0;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (stopAtBrace && ch === '}' && braceDepth === 0) return i + 1;
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '/' && next === '/') {
        i += 2; while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === '\\') { j += 2; continue; }
          if (source[j++] === ch) break;
        }
        i = j; regexAllowed = false; continue;
      }
      if (ch === '`') { i = scanTemplate(i); regexAllowed = false; continue; }
      if (ch === '/' && regexAllowed) { i = scanRegex(i); regexAllowed = false; continue; }
      if (/[A-Za-z_$]/.test(ch)) {
        const startWord = i++;
        while (/[A-Za-z0-9_$]/.test(source[i] || '')) i++;
        mark(startWord, i);
        const word = source.slice(startWord, i);
        regexAllowed = keywordsAllowingRegex.has(word);
        if (word === 'switch') switchKeywordPending = true;
        if (switchDepth > 0 && (word === 'case' || word === 'default')) caseColonPending = true;
        if (statementStart && !['break', 'case', 'catch', 'continue', 'debugger', 'default', 'do', 'else', 'finally', 'for', 'if', 'return', 'switch', 'throw', 'try', 'while'].includes(word) &&
            nextSignificantCharacter(i) === ':') labelColonPending = true;
        if (word === 'class') {
          classDeclarationPending = previousToken === '' || previousToken === ';' ||
            previousToken === '}' || previousToken === 'export' || previousToken === 'default';
        }
        statementStart = false;
        previousToken = word;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        i++; while (/[A-Za-z0-9_.]/.test(source[i] || '')) i++;
        regexAllowed = false; statementStart = false; continue;
      }
      if (ch === '{') {
        braceDepth++;
        const opensSwitchBlock = switchBlockPending;
        braceKinds.push({ block: blockAfterColonPending || classDeclarationPending || previousToken === ')' || previousToken === '=>' ||
          previousToken === '' || previousToken === ';' || previousToken === '}' ||
          ['else', 'try', 'finally', 'do', 'export', 'default'].includes(previousToken), switchBlock: opensSwitchBlock });
        if (opensSwitchBlock) switchDepth++;
        switchBlockPending = false;
        blockAfterColonPending = false;
        classDeclarationPending = false;
        mark(i, i + 1); regexAllowed = true; statementStart = true; previousToken = '{'; i++; continue;
      }
      if (ch === '}') {
        if (braceDepth > 0) braceDepth--;
        const braceKind = braceKinds.pop() || {};
        if (braceKind.switchBlock) switchDepth = Math.max(0, switchDepth - 1);
        const closesBlock = braceKind.block === true;
        mark(i, i + 1); regexAllowed = closesBlock; statementStart = closesBlock; previousToken = '}'; i++; continue;
      }
      mark(i, i + 1);
      if (ch === '(') {
        controlParens.push({ regex: ['if', 'while', 'for', 'with', 'switch', 'catch'].includes(previousToken), switch: switchKeywordPending });
        switchKeywordPending = false;
        regexAllowed = true; statementStart = false;
      }
      else if (ch === ')') {
        const paren = controlParens.pop() || {};
        regexAllowed = paren.regex === true;
        if (paren.switch) switchBlockPending = true;
        statementStart = false;
      }
      else if (ch === ']') regexAllowed = false;
      else if (ch === '.' ) regexAllowed = false;
      else if (ch === '+' && next === '+' || ch === '-' && next === '-') { i += 2; regexAllowed = false; continue; }
      else if (ch === ':') {
        const opensBlock = nextSignificantCharacter(i + 1) === '{' && (labelColonPending || caseColonPending);
        blockAfterColonPending = opensBlock;
        if (labelColonPending) labelColonPending = false;
        if (opensBlock) caseColonPending = false;
        statementStart = opensBlock;
        regexAllowed = true;
      }
      else if (ch === ';') { statementStart = true; caseColonPending = false; regexAllowed = true; }
      else regexAllowed = true;
      if (![':', ';', '(', ')', '{', '}'].includes(ch)) statementStart = false;
      previousToken = ch;
      i++;
    }
    return i;
  };
  scanCode(0);
  return view.join('');
}

function findCallEnd(mask, open) {
  let depth = 1;
  for (let i = open + 1; i < mask.length; i++) {
    if (mask[i] === '(') depth++;
    else if (mask[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function splitArguments(source, mask, open, close) {
  const args = [];
  let start = open + 1;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let i = start;
  while (i < close) {
    const ch = mask[i];
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    else if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === ',' && parens === 0 && brackets === 0 && braces === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const last = source.slice(start, close).trim();
  if (last || args.length) args.push(last);
  return args;
}

function decodeStringLiteral(expression) {
  let start = 0;
  let end = expression.length;
  const skipLeadingTrivia = () => {
    while (start < end) {
      if (/\s/.test(expression[start])) { start++; continue; }
      if (expression.startsWith('/*', start)) {
        const close = expression.indexOf('*/', start + 2);
        if (close < 0 || close + 2 > end) return;
        start = close + 2; continue;
      }
      if (expression.startsWith('//', start)) {
        let newline = expression.indexOf('\n', start + 2);
        const carriageReturn = expression.indexOf('\r', start + 2);
        if (newline < 0 || (carriageReturn >= 0 && carriageReturn < newline)) newline = carriageReturn;
        start = newline < 0 || newline >= end ? end : newline + 1;
        if (expression[newline] === '\r' && expression[newline + 1] === '\n') start++;
        continue;
      }
      break;
    }
  };
  const skipTrailingTrivia = () => {
    let changed = true;
    while (changed) {
      changed = false;
      while (end > start && /\s/.test(expression[end - 1])) { end--; changed = true; }
      if (end - start >= 2 && expression.slice(end - 2, end) === '*/') {
        const open = expression.lastIndexOf('/*', end - 2);
        if (open >= start) { end = open; changed = true; continue; }
      }
      const lineStart = expression.lastIndexOf('//', end - 1);
      if (lineStart >= start && !/[\r\n]/.test(expression.slice(lineStart, end))) { end = lineStart; changed = true; }
    }
  };
  skipLeadingTrivia();
  skipTrailingTrivia();
  const value = expression.slice(start, end).trim();
  if (value.length < 2 || !['"', "'"].includes(value[0]) || value.at(-1) !== value[0]) return null;
  if (value[0] === '"') {
    try { return JSON.parse(value); } catch { return null; }
  }
  // Event names in this codebase use simple single-quoted ASCII literals.
  const body = value.slice(1, -1);
  if (/\\(?!['\\])/.test(body)) return null;
  return body.replace(/\\(['\\])/g, '$1');
}

export function scanRecordEventCallsites(source, relativeFile) {
  const rows = [];
  const mask = executableCodeView(source);
  const callPattern = /\b[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\?\s*\.\s*|\.\s*)recordEvent\s*(?:\?\s*\.\s*)?\(/g;
  for (const match of mask.matchAll(callPattern)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = findCallEnd(mask, open);
    if (close < 0) continue;
    const args = splitArguments(source, mask, open, close);
    if (args.length < 2) continue;
    const eventType = decodeStringLiteral(args[1]);
    rows.push({
      file: relativeFile,
      line: source.slice(0, match.index).split(/\r\n|\r|\n/).length,
      invocation: 'member-call',
      jobIdArgument: args[0],
      eventTypeArgument: args[1],
      classification: eventType === null ? 'computed-or-unresolved' : 'literal',
      literalEventType: eventType
    });
  }
  return rows;
}

function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

export function buildInventory(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entrypoint = pkg.runtimeEntryPoint || pkg.main;
  if (!entrypoint || entrypoint !== pkg.main) throw new Error('package.json main/runtimeEntryPoint mismatch or missing');
  const entryAbsolute = path.resolve(root, entrypoint);
  const runtimeDirectory = path.join(root, 'src/runtime');
  const files = [...new Set([entryAbsolute, ...listJavaScriptFiles(runtimeDirectory)])].sort();
  const callsites = [];
  const fileSummaries = [];
  for (const absolute of files) {
    const bytes = fs.readFileSync(absolute);
    const source = bytes.toString('utf8');
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const discovered = scanRecordEventCallsites(source, relative);
    callsites.push(...discovered);
    fileSummaries.push({
      file: relative,
      sha256: sha256(bytes),
      recordEventCallsites: discovered.length
    });
  }
  callsites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const literalTypes = [...new Set(callsites.map(row => row.literalEventType).filter(Boolean))].sort();
  return {
    schemaVersion: 1,
    auditKind: 'source-only-recordEvent-caller-inventory',
    configuredEntrypoint: entrypoint,
    sourceFilesScanned: files.length,
    callsiteCount: callsites.length,
    literalCallsiteCount: callsites.filter(row => row.classification === 'literal').length,
    computedOrUnresolvedCallsiteCount: callsites.filter(row => row.classification !== 'literal').length,
    distinctLiteralEventTypeCount: literalTypes.length,
    distinctLiteralEventTypes: literalTypes,
    fileSummaries,
    callsites,
    limitations: [
      'Static source discovery only; not a runtime/deployed process or worker inventory.',
      'Bounded lexical member-call scan, not a JavaScript AST; aliases, generated calls, unusual or unsupported JavaScript grammar, ambiguous regex-versus-division contexts, cross-file indirection, and direct SQL event writes may be missed or misclassified.',
      'Computed/caller-supplied event types require manual call-graph and input-contract review.',
      'Does not inspect existing database rows, migrations, direct SQL event writes, or every event reader.',
      'Does not define or enforce an authorization-event registry and is not an external authority.'
    ]
  };
}

function selfTest() {
  const sample = `// this.recordEvent(id, 'comment.only', {});
const text = "store.recordEvent(id, 'string.only', {})";
const template = \`ignore this.recordEvent(id, 'template.only', {})\`;
this.recordEvent(jobId, 'literal.event', { nested: [1, 2] }, key);
store?.recordEvent(jobId,
  terminalType ? 'success.type' : 'failure.type',
  { nested: { list: [1, 2] } });
recordEvent(jobId, type, payload) { return true; }`;
  const rows = scanRecordEventCallsites(sample, 'fixture.js');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].literalEventType, 'literal.event');
  assert.equal(rows[1].classification, 'computed-or-unresolved');
  assert.equal(rows[1].eventTypeArgument, "terminalType ? 'success.type' : 'failure.type'");
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    process.stdout.write('PASS audit-agg-v2-event-callers self-test\n');
    return;
  }
  const inventory = buildInventory();
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  const outputIndex = argv.indexOf('--output');
  if (outputIndex >= 0) {
    const outputPath = path.resolve(argv[outputIndex + 1] || '');
    if (!argv[outputIndex + 1]) throw new Error('--output requires a file path');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Wrote ${path.relative(ROOT, outputPath)}\n`);
  } else if (argv.includes('--json')) {
    process.stdout.write(json);
  } else {
    process.stdout.write(`Configured entrypoint: ${inventory.configuredEntrypoint}\n`);
    process.stdout.write(`Files scanned: ${inventory.sourceFilesScanned}\n`);
    process.stdout.write(`recordEvent callsites: ${inventory.callsiteCount} (${inventory.literalCallsiteCount} literal; ${inventory.computedOrUnresolvedCallsiteCount} computed/unresolved)\n`);
    process.stdout.write(`Distinct literal event types: ${inventory.distinctLiteralEventTypeCount}\n`);
    for (const row of inventory.callsites) {
      process.stdout.write(`${row.file}:${row.line}\t${row.classification}\t${row.literalEventType ?? row.eventTypeArgument}\n`);
    }
    process.stdout.write('LIMITED: source-only inventory; not deployed inventory, schema manifest, event allowlist or external authority.\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
}
