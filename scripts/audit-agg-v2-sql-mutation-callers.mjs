#!/usr/bin/env node
/**
 * Read-only lexical inventory of direct SQLite prepare()/exec() callsites.
 * This is source discovery only: it is not an AST, complete writer proof,
 * projection manifest, deployment inventory, or authorization control.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_API_CALL_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:[ \t]*(?:\?\.|\.)[ \t]*[A-Za-z_$][A-Za-z0-9_$]*)*[ \t]*(?:\?\.|\.)(?:[ \t]*)(prepare|exec)(?:[ \t]*\?\.)?[ \t]*\(/g;
const SQL_API_CALL_PATTERN_MULTILINE = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][A-Za-z0-9_$]*)*\s*(?:\?\.|\.)\s*(prepare|exec)(?:\s*\?\.)?\s*\(/g;
const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'of', 'return',
  'throw', 'typeof', 'void', 'yield'
]);

function skipQuoted(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index++; continue; }
    if (source[index] === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      return end < 0 ? source.length : skipTrivia(source, end + 2);
    }
    break;
  }
  return index;
}

function findCallEnd(source, open) {
  let depth = 1;
  let index = open + 1;
  while (index < source.length && depth > 0) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (character === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipTrivia(source, index);
      continue;
    }
    if (character === '(') depth++;
    else if (character === ')') depth--;
    index++;
  }
  return depth === 0 ? index - 1 : -1;
}

function splitArguments(source, open, close) {
  const args = [];
  let start = open + 1;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  let index = start;
  while (index < close) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (character === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipTrivia(source, index);
      continue;
    }
    if (character === '(') parens++;
    else if (character === ')') parens--;
    else if (character === '[') brackets++;
    else if (character === ']') brackets--;
    else if (character === '{') braces++;
    else if (character === '}') braces--;
    else if (character === ',' && parens === 0 && brackets === 0 && braces === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
    index++;
  }
  const last = source.slice(start, close).trim();
  if (last || args.length) args.push(last);
  return args;
}

function isRegexLiteralStart(source, start, blockCloseOffsets = new Set()) {
  let previous = start - 1;
  while (previous >= 0 && /\s/.test(source[previous])) previous--;
  if (previous < 0) return true;
  const character = source[previous];
  if (character === '}' && blockCloseOffsets.has(previous)) return true;
  if ('([{,:;=!?&|+-*%^~<>/'.includes(character)) return true;
  const prefix = source.slice(0, start);
  if (character === ')' && /\b(?:catch|for|if|while|with)\s*\([^)]*\)\s*$/.test(prefix)) return true;
  const word = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(prefix)?.[1];
  return REGEX_PREFIX_KEYWORDS.has(word);
}

function isBlockBraceOpen(source, start, enclosingBraceKinds = []) {
  const prefix = source.slice(0, start).trimEnd();
  const functionIndex = prefix.lastIndexOf('function');
  if (functionIndex >= 0 && /\)\s*$/.test(prefix)) {
    const beforeFunction = prefix.slice(0, functionIndex).trimEnd();
    const declarationContext = !beforeFunction || /[;{}]$/.test(beforeFunction) ||
      /^(?:async|default|export(?:\s+(?:default|async)){0,2})$/.test(beforeFunction);
    if (!declarationContext) return false;
  }
  const classIndex = prefix.lastIndexOf('class');
  if (classIndex >= 0 && /\bclass(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?$/.test(prefix)) {
    const beforeClass = prefix.slice(0, classIndex).trimEnd();
    return !beforeClass || /[;{}]$/.test(beforeClass) ||
      /^(?:default|export(?:\s+(?:default|async)){0,2})$/.test(beforeClass);
  }
  if (/\bcatch$/.test(prefix)) return true;
  const label = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:$/.exec(prefix);
  if (label) {
    // A property value inside an object literal is not a labelled statement.
    if (enclosingBraceKinds.at(-1) === false) return false;
    const beforeLabel = prefix.slice(0, label.index).trimEnd();
    return !beforeLabel || /[;{}]$/.test(beforeLabel) || /\)$/.test(beforeLabel) || /=>$/.test(beforeLabel);
  }
  return /(?:\)|\b(?:else|try|finally|do))$/.test(prefix) || /[;{}]$/.test(prefix);
}

function skipRegexLiteral(source, start) {
  let inCharacterClass = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (character === '\n' || character === '\r') return start + 1;
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '[') { inCharacterClass = true; continue; }
    if (character === ']' && inCharacterClass) { inCharacterClass = false; continue; }
    if (character === '/' && !inCharacterClass) {
      index++;
      while (/[A-Za-z]/.test(source[index] || '')) index++;
      return index;
    }
  }
  return source.length;
}

export function buildExecutableMask(source) {
  const mask = new Uint8Array(source.length);
  const reason = new Uint8Array(source.length);
  let mode = 'code';
  let quoteReturnMode = 'code';
  let commentReturnMode = 'code';
  let escaped = false;
  let expressionDepth = 0;
  const templateFrames = [];
  const braceKinds = [];
  const blockCloseOffsets = new Set();
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (mode === 'line-comment') {
      reason[index] = 3;
      if (character === '\n') mode = commentReturnMode;
      continue;
    }
    if (mode === 'block-comment') {
      reason[index] = 4;
      if (character === '*' && next === '/') { reason[index + 1] = 4; mode = commentReturnMode; index++; }
      continue;
    }
    if (mode === 'single-quote' || mode === 'double-quote') {
      reason[index] = 1;
      if (character === '\n' && !escaped) mode = quoteReturnMode;
      else if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if ((mode === 'single-quote' && character === "'") || (mode === 'double-quote' && character === '"')) mode = quoteReturnMode;
      continue;
    }
    if (mode === 'template') {
      reason[index] = 2;
      if (character === '\\') { if (index + 1 < source.length) reason[index + 1] = 2; index++; continue; }
      if (character === '`') {
        const frame = templateFrames.pop();
        mode = frame?.returnMode || 'code';
        expressionDepth = frame?.expressionDepth || 0;
      } else if (character === '$' && next === '{') {
        reason[index + 1] = 2;
        mode = 'template-expression';
        expressionDepth = 1;
        index++;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      commentReturnMode = mode;
      mode = 'line-comment';
      reason[index] = 3;
      reason[index + 1] = 3;
      index++;
      continue;
    }
    if (character === '/' && next === '*') {
      commentReturnMode = mode;
      mode = 'block-comment';
      reason[index] = 4;
      reason[index + 1] = 4;
      index++;
      continue;
    }
    if (character === '/' && isRegexLiteralStart(source, index, blockCloseOffsets)) {
      const end = skipRegexLiteral(source, index);
      if (end > index + 1) {
        for (let cursor = index; cursor < end; cursor++) reason[cursor] = 5;
        index = end - 1;
        continue;
      }
    }
    if (character === '"' || character === "'") {
      quoteReturnMode = mode;
      mode = character === '"' ? 'double-quote' : 'single-quote';
      reason[index] = 1;
      continue;
    }
    if (character === '`') {
      templateFrames.push({ returnMode: mode, expressionDepth });
      mode = 'template';
      reason[index] = 2;
      continue;
    }
    if (mode === 'template-expression') {
      if (character === '{') expressionDepth++;
      else if (character === '}') {
        expressionDepth--;
        if (expressionDepth === 0) {
          mode = 'template';
          reason[index] = 2;
          continue;
        }
      }
    }
    if (character === '{') braceKinds.push(isBlockBraceOpen(source, index, braceKinds));
    else if (character === '}') {
      const closedBlock = braceKinds.pop() === true;
      if (closedBlock) blockCloseOffsets.add(index);
    }
    mask[index] = 1;
  }
  return { mask, reason };
}

function decodeSqlLiteral(expression) {
  const value = expression.trim();
  if (value.length < 2 || value.at(-1) !== value[0]) return null;
  if (value[0] === '"') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value[0] === "'") {
    const body = value.slice(1, -1);
    if (/\\(?!['\\])/.test(body)) return null;
    return body.replace(/\\(['\\])/g, '$1');
  }
  if (value[0] === '`') {
    const body = value.slice(1, -1);
    if (body.includes('${')) return null;
    return body.replace(/\\`/g, '`').replace(/\\\\/g, '\\');
  }
  return null;
}

// Preserve SQL text outside JavaScript template interpolations. Dynamic SQL
// remains unresolved, but static FROM/JOIN references must still be audited.
function decodeSqlTemplateStaticSegments(expression) {
  const value = expression.trim();
  if (!value.startsWith('`') || !value.endsWith('`')) return null;
  const body = value.slice(1, -1);
  let output = '';
  let index = 0;
  while (index < body.length) {
    if (body[index] === '\\') {
      output += body[index + 1] || '';
      index += 2;
      continue;
    }
    if (body[index] !== '$' || body[index + 1] !== '{') {
      output += body[index++];
      continue;
    }

    index += 2;
    let depth = 1;
    let quote = null;
    let lineComment = false;
    let blockComment = false;
    while (index < body.length && depth > 0) {
      const character = body[index];
      const next = body[index + 1];
      if (lineComment) {
        if (character === '\n' || character === '\r') lineComment = false;
        index++;
        continue;
      }
      if (blockComment) {
        if (character === '*' && next === '/') { blockComment = false; index += 2; }
        else index++;
        continue;
      }
      if (quote) {
        if (character === '\\') { index += 2; continue; }
        if (character === quote) quote = null;
        index++;
        continue;
      }
      if (character === '/' && next === '/') { lineComment = true; index += 2; continue; }
      if (character === '/' && next === '*') { blockComment = true; index += 2; continue; }
      if (character === "'" || character === '"' || character === '`') { quote = character; index++; continue; }
      if (character === '{') depth++;
      else if (character === '}') depth--;
      index++;
    }
    if (depth !== 0) return null;
    output += ' ? ';
  }
  return output;
}

function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let mode = 'code';
  let quote = '';
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    const next = sql[index + 1];
    if (mode === 'line-comment') {
      if (character === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block-comment') {
      if (character === '*' && next === '/') { mode = 'code'; index++; }
      continue;
    }
    if (mode === 'quoted') {
      if (character === quote && next === quote) { index++; continue; }
      if (character === quote) mode = 'code';
      continue;
    }
    if (character === '-' && next === '-') { mode = 'line-comment'; index++; continue; }
    if (character === '/' && next === '*') { mode = 'block-comment'; index++; continue; }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character;
      mode = 'quoted';
      continue;
    }
    if (character === ';') {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const finalStatement = sql.slice(start).trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}

function stripLeadingSqlComments(sql) {
  let normalized = sql.trim();
  while (normalized) {
    if (normalized.startsWith('--')) {
      const newline = normalized.indexOf('\n');
      normalized = newline < 0 ? '' : normalized.slice(newline + 1).trimStart();
      continue;
    }
    if (normalized.startsWith('/*')) {
      const close = normalized.indexOf('*/', 2);
      normalized = close < 0 ? '' : normalized.slice(close + 2).trimStart();
      continue;
    }
    break;
  }
  return normalized;
}

function sqlStatementMetadata(sql) {
  const normalized = stripLeadingSqlComments(sql).trim();
  const verb = /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|VACUUM|REINDEX|ATTACH|DETACH|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END|WITH|SELECT|EXPLAIN)\b/i.exec(normalized)?.[1]?.toUpperCase() || null;
  const writeVerbs = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
  const schemaVerbs = new Set(['CREATE', 'ALTER', 'DROP']);
  let operationClass = 'other-or-unresolved';
  if (writeVerbs.has(verb)) operationClass = 'data-write';
  else if (schemaVerbs.has(verb)) operationClass = 'schema-write';
  else if (verb === 'PRAGMA') operationClass = 'pragma-read-or-write';
  else if (['VACUUM', 'REINDEX', 'ATTACH', 'DETACH'].includes(verb)) operationClass = 'connection-or-database-mutation';
  else if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END'].includes(verb)) operationClass = 'transaction-control';
  else if (verb === 'WITH') operationClass = 'with-clause-unresolved';
  else if (verb === 'SELECT' || verb === 'EXPLAIN') operationClass = 'read';

  const identifier = '(?:"([^"]+)"|`([^`]+)`|\\[([^\\]]+)\\]|([A-Za-z_][A-Za-z0-9_.]*))';
  const patterns = [
    new RegExp(`^(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO)\\s*${identifier}`, 'i'),
    new RegExp(`^UPDATE\\s+(?:OR\\s+\\w+\\s+)?${identifier}`, 'i'),
    new RegExp(`^DELETE\\s+FROM\\s*${identifier}`, 'i'),
    new RegExp(`^(?:CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|ALTER\\s+TABLE\\s+|DROP\\s+(?:TABLE|INDEX|TRIGGER|VIEW)\\s+(?:IF\\s+EXISTS\\s+)?)${identifier}`, 'i')
  ];
  let objectName = null;
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match) { objectName = match.slice(1).find(Boolean) || null; break; }
  }
  if (verb === 'PRAGMA') objectName = /^PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_.]*)/i.exec(normalized)?.[0]?.replace(/^PRAGMA\s+/i, '') || null;
  const referencedObjects = [];
  if (['SELECT', 'EXPLAIN'].includes(verb)) {
    const readPattern = new RegExp(`\\b(?:FROM|JOIN)\\s*${identifier}`, 'ig');
    for (const match of normalized.matchAll(readPattern)) {
      const name = match.slice(1).find(Boolean);
      if (name && !referencedObjects.includes(name)) referencedObjects.push(name);
    }
    objectName = referencedObjects[0] || null;
  } else if (writeVerbs.has(verb) && objectName) referencedObjects.push(objectName);
  else if (schemaVerbs.has(verb) && objectName) {
    referencedObjects.push(objectName);
    if (/^CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?INDEX\\b/i.test(normalized)) {
      const onMatch = new RegExp(`\\bON\\s*${identifier}`, 'i').exec(normalized);
      const table = onMatch?.slice(1).find(Boolean);
      if (table && !referencedObjects.includes(table)) referencedObjects.push(table);
    }
  }
  return { sqlVerb: verb, operationClass, objectName, referencedObjects };
}

function sqlMetadata(sql) {
  const statements = splitSqlStatements(sql).map(sqlStatementMetadata);
  if (!statements.length) return { sqlVerb: null, operationClass: 'other-or-unresolved', objectName: null,
    referencedObjects: [], multiStatement: false, statementVerbs: [], statementOperationClasses: [], containsMutation: false };
  if (statements.length === 1) return {
    ...statements[0], multiStatement: false, statementVerbs: [statements[0].sqlVerb],
    statementOperationClasses: [statements[0].operationClass], containsMutation: false
  };
  const mutationClasses = new Set(['data-write', 'schema-write', 'pragma-read-or-write',
    'connection-or-database-mutation', 'transaction-control']);
  return {
    sqlVerb: statements[0].sqlVerb,
    operationClass: 'multi-statement-unresolved',
    objectName: statements.find(statement => statement.objectName)?.objectName || null,
    referencedObjects: [...new Set(statements.flatMap(statement => statement.referencedObjects || []))],
    multiStatement: true,
    statementVerbs: statements.map(statement => statement.sqlVerb),
    statementOperationClasses: statements.map(statement => statement.operationClass),
    statementDetails: statements,
    containsMutation: statements.some(statement => mutationClasses.has(statement.operationClass))
  };
}

export function scanSqlMutationCallsites(source, relativeFile, executableMask = null, lexicalReason = null) {
  if (!executableMask || !lexicalReason) {
    const lexical = buildExecutableMask(source);
    executableMask ||= lexical.mask;
    lexicalReason ||= lexical.reason;
  }
  const rows = [];
  const lines = source.split('\n');
  let absoluteOffset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const matchingLine = line.split('').map((character, index) =>
      [3, 4].includes(lexicalReason[absoluteOffset + index]) ? ' ' : character).join('');
    for (const match of matchingLine.matchAll(new RegExp(SQL_API_CALL_PATTERN.source, 'g'))) {
      if (!executableMask[absoluteOffset + match.index]) continue;
      const open = absoluteOffset + match.index + match[0].lastIndexOf('(');
      const close = findCallEnd(source, open);
      if (close < 0) continue;
      const args = splitArguments(source, open, close);
      if (!args.length) continue;
      const sql = decodeSqlLiteral(args[0]);
      const staticSql = sql === null ? decodeSqlTemplateStaticSegments(args[0]) : null;
      const staticMetadata = staticSql === null ? null : sqlMetadata(staticSql);
      const metadata = sql !== null ? sqlMetadata(sql) : staticMetadata ? {
        ...staticMetadata,
        operationClass: 'computed-or-unresolved'
      } : { sqlVerb: null, operationClass: 'computed-or-unresolved', objectName: null, referencedObjects: [], multiStatement: false };
      rows.push({
        file: relativeFile,
        line: lineIndex + 1,
        column: match.index + 1,
        api: match[1],
        sqlArgument: args[0],
        ...(staticSql === null ? {} : { staticSql }),
        classification: sql === null ? 'computed-or-unresolved' : 'literal-sql',
        ...metadata,
        sqlSha256: sql === null ? null : crypto.createHash('sha256').update(sql, 'utf8').digest('hex')
      });
    }
    absoluteOffset += line.length + 1;
  }
  return rows;
}

export function scanSqlAuditFile(source, relativeFile) {
  const lexicalMask = buildExecutableMask(source);
  const executableMask = lexicalMask.mask;
  const matchingSource = source.split('').map((character, index) =>
    [3, 4].includes(lexicalMask.reason[index]) ? ' ' : character).join('');
  const rawCandidates = [...source.matchAll(new RegExp(SQL_API_CALL_PATTERN.source, 'g'))];
  const rawCandidateOffsets = new Set(rawCandidates.map(match => match.index));
  for (const match of matchingSource.matchAll(new RegExp(SQL_API_CALL_PATTERN.source, 'g'))) {
    if (!rawCandidateOffsets.has(match.index)) rawCandidates.push(match);
  }
  rawCandidates.sort((left, right) => left.index - right.index);
  const multilineTextualCandidates = [...source.matchAll(new RegExp(SQL_API_CALL_PATTERN_MULTILINE.source, 'g'))]
    .filter(match => match[0].includes('\n'))
    .map(match => {
      const prefix = source.slice(0, match.index);
      return {
        file: relativeFile,
        line: (prefix.match(/\n/g) || []).length + 1,
        column: match.index - prefix.lastIndexOf('\n'),
        api: match[1],
        classification: executableMask[match.index] ? 'multiline-receiver-or-member-syntax-needs-manual-review' : 'masked-candidate',
        maskReason: ({ 1: 'quoted-string', 2: 'template-literal-text', 3: 'line-comment', 4: 'block-comment', 5: 'regex-literal' })[lexicalMask.reason[match.index]] || 'unknown-lexical-context'
      };
    });
  const callsites = scanSqlMutationCallsites(source, relativeFile, executableMask, lexicalMask.reason);
  const accepted = new Set(callsites.map(row => `${row.line}:${row.column}:${row.api}`));
  const unmatchedRawTextualCandidates = [];
  for (const match of rawCandidates) {
    const prefix = source.slice(0, match.index);
    const line = (prefix.match(/\n/g) || []).length + 1;
    const column = match.index - (prefix.lastIndexOf('\n'));
    const api = match[1];
    if (accepted.has(`${line}:${column}:${api}`)) continue;
    unmatchedRawTextualCandidates.push({
      file: relativeFile,
      line,
      column,
      api,
      classification: executableMask[match.index] ? 'call-parser-unresolved' : 'masked-candidate',
      maskReason: ({ 1: 'quoted-string', 2: 'template-literal-text', 3: 'line-comment', 4: 'block-comment', 5: 'regex-literal' })[lexicalMask.reason[match.index]] || 'unknown-lexical-context'
    });
  }
  return { rawTextualCandidateCount: rawCandidates.length, callsites, unmatchedRawTextualCandidates, multilineTextualCandidates };
}

function listModules(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listModules(absolute));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

export function buildInventory(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entrypoint = pkg.runtimeEntryPoint || pkg.main;
  if (!entrypoint || entrypoint !== pkg.main) throw new Error('package.json main/runtimeEntryPoint mismatch or missing');
  const files = [...new Set([
    path.resolve(root, entrypoint),
    ...listModules(path.join(root, 'src/runtime')),
    ...listModules(path.join(root, 'scripts'))
  ])].filter(absolute => absolute !== path.join(root, 'scripts/audit-agg-v2-sql-mutation-callers.mjs')).sort();
  const callsites = [];
  const fileSummaries = [];
  const unmatchedRawTextualCandidates = [];
  const multilineTextualCandidates = [];
  let rawTextualCandidateCount = 0;
  for (const absolute of files) {
    const bytes = fs.readFileSync(absolute);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const source = bytes.toString('utf8');
    const audit = scanSqlAuditFile(source, relative);
    rawTextualCandidateCount += audit.rawTextualCandidateCount;
    callsites.push(...audit.callsites);
    unmatchedRawTextualCandidates.push(...audit.unmatchedRawTextualCandidates);
    multilineTextualCandidates.push(...audit.multilineTextualCandidates);
    fileSummaries.push({ file: relative, sha256: sha256(bytes), rawTextualCandidates: audit.rawTextualCandidateCount,
      directSqlCallsites: audit.callsites.length, unmatchedRawTextualCandidates: audit.unmatchedRawTextualCandidates.length,
      multilineTextualCandidates: audit.multilineTextualCandidates.length });
  }
  callsites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const byClass = Object.fromEntries([...new Set(callsites.map(row => row.operationClass))].sort().map(key => [key, callsites.filter(row => row.operationClass === key).length]));
  const referencedObjectCounts = {};
  for (const row of callsites) {
    const details = row.statementDetails || [row];
    for (const detail of details) for (const objectName of detail.referencedObjects || []) {
      const key = `${detail.operationClass}:${objectName}`;
      referencedObjectCounts[key] = (referencedObjectCounts[key] || 0) + 1;
    }
  }
  const unmatchedByMaskReason = {};
  for (const row of unmatchedRawTextualCandidates) unmatchedByMaskReason[row.maskReason] = (unmatchedByMaskReason[row.maskReason] || 0) + 1;
  const multilineByMaskReason = {};
  for (const row of multilineTextualCandidates) multilineByMaskReason[row.maskReason] = (multilineByMaskReason[row.maskReason] || 0) + 1;
  return {
    schemaVersion: 1,
    auditKind: 'source-only-direct-sql-callsite-inventory',
    configuredEntrypoint: entrypoint,
    scope: ['configured RC.71 entrypoint', 'src/runtime/**/*.js', 'src/runtime/**/*.mjs', 'scripts/**/*.js', 'scripts/**/*.mjs'],
    sourceFilesScanned: files.length,
    rawTextualCandidateCount,
    multilineTextualCandidateCount: multilineTextualCandidates.length,
    totalTextualCandidateCount: rawTextualCandidateCount + multilineTextualCandidates.length,
    directSqlCallsiteCount: callsites.length,
    unmatchedRawTextualCandidateCount: unmatchedRawTextualCandidates.length,
    literalSqlCallsiteCount: callsites.filter(row => row.classification === 'literal-sql').length,
    computedOrUnresolvedCallsiteCount: callsites.filter(row => row.classification !== 'literal-sql').length,
    operationClassCounts: byClass,
    distinctReferencedObjectCount: new Set(callsites.flatMap(row => row.referencedObjects || [])).size,
    referencedObjectCounts: Object.fromEntries(Object.entries(referencedObjectCounts).sort(([a], [b]) => a.localeCompare(b))),
    dataWriteCallsiteCount: callsites.filter(row => row.operationClass === 'data-write' || row.statementOperationClasses?.includes('data-write')).length,
    schemaWriteCallsiteCount: callsites.filter(row => row.operationClass === 'schema-write' || row.statementOperationClasses?.includes('schema-write')).length,
    multiStatementCallsiteCount: callsites.filter(row => row.multiStatement).length,
    multiStatementMutationCallsiteCount: callsites.filter(row => row.multiStatement && row.containsMutation).length,
    unresolvedCallsiteCount: callsites.filter(row => ['computed-or-unresolved', 'with-clause-unresolved', 'other-or-unresolved', 'multi-statement-unresolved'].includes(row.operationClass)).length,
    fileSummaries,
    callsites,
    unmatchedRawTextualCandidates,
    multilineTextualCandidates,
    unmatchedByMaskReason,
    multilineByMaskReason,
    limitations: [
      'Lexical member-call discovery, not a JavaScript AST or complete call graph.',
      'Raw textual prepare/exec candidates not accepted by the lexical mask are counted separately; they may be comments/strings/templates or missed executable callsites and require manual review.',
      'Multiline receiver/member patterns are reported separately; the executable-call scanner intentionally accepts only same-line receiver/member syntax.',
      'May miss aliases, destructured APIs, imported wrappers, generated SQL, complex template interpolation, calls whose receiver/member syntax spans lines, context-sensitive regex/division boundaries outside the regression corpus, and non-SQL write APIs.',
      'Dynamic SQL and WITH-prefixed statements remain unresolved. Multi-statement SQL is split outside quoted strings/comments, every statement verb/class is exposed, and the aggregate callsite remains unresolved for manual review.',
      'Scans configured entrypoint plus src/runtime and scripts; does not prove deployment, alternate process inventory, native addons, external writers or absence of DB access outside these roots.',
      'Callsites are not automatically security-relevant; each table/column/row and authorization reader/writer mapping requires reviewed data-flow analysis.',
      'Does not define or enforce V2-08 projections, event allowlists, database identity, custody, external authority or production readiness.'
    ]
  };
}

function selfTest() {
  const sample = `// db.prepare('DELETE FROM ignored');
const text = "db.exec('DROP TABLE ignored')";
const regex = /db\\.prepare\\('DELETE FROM ignored'\\)/;
const multiline = \`
  db.prepare('DELETE FROM multiline_template_ignored').run();
\`;
db.prepare('INSERT OR IGNORE INTO events(event_id) VALUES(?)').run(id);
store.db.prepare(\`UPDATE tasks SET status=? WHERE task_id=?\`).run(status, id);
db.exec('CREATE TABLE IF NOT EXISTS sample(id TEXT); INSERT INTO sample VALUES(1);');
db.prepare(sqlFromCaller).run();
db.prepare(\`DELETE FROM tasks WHERE task_id=${'${'}taskId}\`).run();
db.prepare('SELECT * FROM jobs').all();
db.prepare('SELECT jobs.job_id FROM jobs JOIN tasks ON tasks.job_id=jobs.job_id').all();
prepare(sql) { return true; }`;
  const rows = scanSqlMutationCallsites(sample, 'fixture.js');
  assert.equal(rows.length, 7);
  assert.equal(rows[0].operationClass, 'data-write');
  assert.equal(rows[0].objectName, 'events');
  assert.equal(rows[1].operationClass, 'data-write');
  assert.equal(rows[1].objectName, 'tasks');
  assert.equal(rows[2].operationClass, 'multi-statement-unresolved');
  assert.deepEqual(rows[2].statementOperationClasses, ['schema-write', 'data-write']);
  assert.equal(rows[2].multiStatement, true);
  assert.equal(rows[3].classification, 'computed-or-unresolved');
  assert.equal(rows[4].classification, 'computed-or-unresolved');
  assert.equal(rows[5].operationClass, 'read');
  assert.deepEqual(rows[5].referencedObjects, ['jobs']);
  assert.deepEqual(rows[6].referencedObjects, ['jobs', 'tasks']);
  const edgeCases = scanSqlAuditFile([
    "if (enabled) {} /db.exec('DROP TABLE ignored')/.test(input);",
    "const expression = function () {} / db.exec('DELETE FROM function_expression');",
    "label: {} /db.exec('DROP TABLE ignored_label')/.test(input);",
    "try {} catch {} /db.exec('DROP TABLE ignored_optional_catch')/.test(input);",
    "db?.prepare('DELETE FROM tasks').run();",
    "db /* receiver */ .prepare('SELECT * FROM jobs').get();",
    "db.exec('SELECT 1; DELETE FROM tasks');"
  ].join('\n'), 'self-test-edge-cases.js');
  assert.equal(edgeCases.callsites.length, 4);
  assert.equal(edgeCases.callsites[0].operationClass, 'data-write');
  assert.equal(edgeCases.callsites[1].operationClass, 'data-write');
  assert.equal(edgeCases.callsites[2].operationClass, 'read');
  assert.equal(edgeCases.callsites[3].operationClass, 'multi-statement-unresolved');
  assert.deepEqual(edgeCases.callsites[3].statementVerbs, ['SELECT', 'DELETE']);
}

function main(argv) {
  if (argv.includes('--self-test')) { selfTest(); process.stdout.write('PASS audit-agg-v2-sql-mutation-callers self-test\n'); return; }
  const inventory = buildInventory();
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  const outputIndex = argv.indexOf('--output');
  if (outputIndex >= 0) {
    const outputPath = path.resolve(argv[outputIndex + 1] || '');
    if (!argv[outputIndex + 1]) throw new Error('--output requires a file path');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Wrote ${path.relative(ROOT, outputPath)}\n`);
  } else {
    process.stdout.write(`Configured entrypoint: ${inventory.configuredEntrypoint}\n`);
    process.stdout.write(`Source files scanned: ${inventory.sourceFilesScanned}\n`);
    process.stdout.write(`Direct SQL callsites: ${inventory.directSqlCallsiteCount} (${inventory.literalSqlCallsiteCount} literal; ${inventory.computedOrUnresolvedCallsiteCount} computed/unresolved)\n`);
    process.stdout.write(`Data writes: ${inventory.dataWriteCallsiteCount}; schema writes: ${inventory.schemaWriteCallsiteCount}; unresolved: ${inventory.unresolvedCallsiteCount}\n`);
    process.stdout.write(`${JSON.stringify(inventory.operationClassCounts)}\n`);
    process.stdout.write('LIMITED: source-only lexical callsite inventory; not complete writer proof, deployed inventory or V2-08 manifest.\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
}
