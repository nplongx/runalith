#!/usr/bin/env node
/**
 * Build a source-only, query-level register from the preserved RC.71 SQL
 * inventory. This is not a projection manifest or deployment attestation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanSqlAuditFile } from './audit-agg-v2-sql-mutation-callers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = 'artifacts/adaptive-goal-graph/rc71-direct-sql-mutation-callers-20261030T132800Z-multi-statement-aware-v2.json';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function decodeLiteral(expression) {
  const value = expression.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value.startsWith("'")) {
    const body = value.slice(1, -1);
    if (/\\(?![\\'"btnfrv0])/u.test(body)) return null;
    return body.replace(/\\([\\'"btnfrv0])/gu, (_, escaped) => ({
      '\\': '\\', "'": "'", '"': '"', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', v: '\v', '0': '\0'
    })[escaped]);
  }
  if (value.startsWith('`') && value.endsWith('`') && !value.includes('${')) {
    return value.slice(1, -1).replace(/\\`/gu, '`').replace(/\\\\/gu, '\\');
  }
  return null;
}

function quotedValues(fragment) {
  return [...fragment.matchAll(/'((?:''|[^'])*)'/gu)].map(match => match[1].replace(/''/gu, "'"));
}

function callerContext(root, row) {
  const lines = fs.readFileSync(path.join(root, row.file), 'utf8').split(/\r?\n/u);
  const classMethod = /^  (?:async\s+)?(?!(?:if|for|while|switch|catch|with|try|return|throw|else|do)\b)([A-Za-z_$][\w$]*)\s*\(/u;
  const topLevelFunction = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/u;
  const topLevelArrow = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u;
  let declaration = null;
  for (let index = row.line - 1; index >= 0; index -= 1) {
    const match = lines[index].match(classMethod) || lines[index].match(topLevelFunction) || lines[index].match(topLevelArrow);
    if (match) {
      let depth = 0;
      let stillOpen = true;
      for (let cursor = index; cursor <= row.line - 1; cursor += 1) {
        for (const character of lines[cursor]) {
          if (character === '{') depth += 1;
          else if (character === '}') depth -= 1;
        }
        if (depth <= 0 && cursor < row.line - 1) { stillOpen = false; break; }
      }
      if (stillOpen && depth > 0) {
        declaration = { name: match[1], line: index + 1, kind: classMethod.test(lines[index]) ? 'class-method' : 'top-level-function' };
        break;
      }
    }
  }
  if (!declaration) return { caller: null, transactionBoundary: 'direct-caller-context-unresolved' };

  const boundaryPattern = declaration.kind === 'class-method'
    ? /^  (?:async\s+)?(?!(?:if|for|while|switch|catch|with|try|return|throw|else|do)\b)[A-Za-z_$][\w$]*\s*\(/u
    : /^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=/u;
  let end = lines.length;
  for (let index = declaration.line; index < lines.length; index += 1) {
    if (boundaryPattern.test(lines[index])) { end = index; break; }
  }
  const startIndex = declaration.line - 1;
  const queryIndex = row.line - 1;
  const beforeQuery = lines.slice(startIndex, queryIndex + 1).join('\n');
  const afterQuery = lines.slice(queryIndex + 1, end).join('\n');
  const begins = [...beforeQuery.matchAll(/\b(?:BEGIN(?:\s+(?:IMMEDIATE|EXCLUSIVE|DEFERRED))?|SAVEPOINT)\b/giu)];
  const ends = [...afterQuery.matchAll(/\b(?:COMMIT|END(?:\s+TRANSACTION)?|ROLLBACK(?:\s+TO(?:\s+SAVEPOINT)?)?|RELEASE(?:\s+SAVEPOINT)?)\b/giu)];
  const transactionBoundary = declaration.name === 'recordAdaptiveGoalApprovalPolicyHighWater'
    ? 'caller-requires-existing-transaction-by-runtime-check'
    : begins.length && ends.length
    ? 'explicit-transaction-markers-surround-query-in-direct-caller'
    : 'no-complete-transaction-bracket-observed-in-direct-caller';
  return {
    caller: { name: declaration.name, declarationLine: declaration.line, resolution: 'nearest-enclosing-declaration-by-source-layout-and-brace-balance' },
    transactionBoundary
  };
}

function queryPurpose(sql, operation) {
  if (operation === 'schema-bootstrap-only') return 'event-schema-and-trigger-bootstrap';
  if (operation === 'writer') return 'event-row-insert';
  if (!sql) return 'sql-expression-unresolved';
  if (/\bWHERE\s+event_id\s*=/iu.test(sql)) return 'event-identity-lookup-or-readback';
  if (/\bCOUNT\s*\(\s*\*\s*\)/iu.test(sql) && /json_extract\s*\(\s*payload_json\s*,\s*['"]\$\.nonce['"]\s*\)/iu.test(sql)) return 'nonce-replay-count';
  if (/\bSELECT\s+1\b/iu.test(sql)) return 'event-existence-check';
  if (/\bCOUNT\s*\(\s*\*\s*\)/iu.test(sql)) return 'event-row-count';
  if (/\bORDER\s+BY\b[\s\S]*\bDESC\b[\s\S]*\bLIMIT\s+1\b/iu.test(sql)) return 'latest-event-or-latest-matching-event';
  if (/\bWHERE\s+type\s*(?:=|IN\s*\()/iu.test(sql)) return 'event-type-filtered-read';
  if (/\bWHERE\s+job_id\s*=/iu.test(sql)) return 'job-scoped-event-read';
  if (!/\bWHERE\b/iu.test(sql)) return 'global-event-scan-or-aggregate';
  return 'selector-specific-event-read';
}

function classifyQuery(row, root) {
  const sql = row.staticSql || decodeLiteral(row.sqlArgument);
  const isMulti = row.multiStatement === true;
  const eventTableDdl = isMulti && /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+events\b/iu.test(sql || '') &&
    (row.statementDetails || []).every(item => ['schema-write', 'transaction-control'].includes(item.operationClass));
  const eventTypes = [];
  if (sql) {
    for (const match of sql.matchAll(/\btype\s*=\s*'((?:''|[^'])*)'/giu)) eventTypes.push(match[1].replace(/''/gu, "'"));
    for (const match of sql.matchAll(/\btype\s+IN\s*\(([^)]*)\)/giu)) eventTypes.push(...quotedValues(match[1]));
  }
  const uniqueTypes = [...new Set(eventTypes)].sort();
  const parameterizedType = Boolean(sql && /\btype\s*(?:=\s*\?|IN\s*\(\s*\?)/iu.test(sql));
  const predicateColumns = [];
  const whereClause = sql ? /\bWHERE\b([\s\S]*?)(?=\b(?:ORDER\s+BY|GROUP\s+BY|LIMIT|RETURNING)\b|$)/iu.exec(sql)?.[1] || '' : '';
  if (whereClause) {
    for (const column of ['event_id', 'job_id', 'type', 'created_at', 'rowid']) {
      if (new RegExp(`\\b${column}\\b`, 'iu').test(whereClause)) predicateColumns.push(column);
    }
  }
  const orderBy = sql ? (/\bORDER\s+BY\s+([\s\S]*?)(?:\bLIMIT\b|$)/iu.exec(sql)?.[1]?.trim().replace(/\s+/gu, ' ') || null) : null;
  let operation = 'unresolved';
  if (row.operationClass === 'read') operation = 'reader';
  else if (row.operationClass === 'data-write') operation = 'writer';
  else if (eventTableDdl) operation = 'schema-bootstrap-only';
  const context = callerContext(root, row);
  return {
    source: { file: row.file, line: row.line, column: row.column, sourceSha256: null },
    api: row.api,
    operation,
    sqlVerb: row.sqlVerb,
    operationClass: row.operationClass,
    sqlSha256: row.sqlSha256,
    staticSqlSha256: row.staticSql ? sha256(row.staticSql) : null,
    sqlSourceExpression: row.sqlArgument,
    referencedObjects: row.referencedObjects || [],
    eventTypeLiterals: uniqueTypes,
    eventTypeParameterized: parameterizedType,
    predicateColumns,
    orderBy,
    queryPurpose: queryPurpose(sql, operation),
    callerContext: context.caller,
    multiStatement: isMulti,
    statementVerbs: row.statementVerbs || [],
    statementOperationClasses: row.statementOperationClasses || [],
    transactionBoundary: context.transactionBoundary,
    authorizationPurpose: 'pending-semantic-reader-review',
    deployedReachability: 'not-established-by-source-inventory'
  };
}

export function buildEventQueryRegister(root = ROOT, input = INPUT, registerId = 'agg-v2-event-query-register-20261030-v0.4') {
  const inventoryPath = path.join(root, input);
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const fileHashes = new Map(inventory.fileSummaries.map(item => [item.file, item.sha256]));
  const preservedRows = inventory.callsites.filter(row =>
    !row.file.startsWith('scripts/') &&
    row.file !== inventory.configuredEntrypoint &&
    ((row.referencedObjects || []).includes('events') ||
      (row.statementDetails || []).some(item => (item.referencedObjects || []).includes('events'))));
  const entrypointPath = path.join(root, inventory.configuredEntrypoint);
  const entrypointBytes = fs.readFileSync(entrypointPath);
  const entrypointSha256 = sha256(entrypointBytes);
  const preservedEntrypointSha256 = fileHashes.get(inventory.configuredEntrypoint);
  const currentEntrypointRows = scanSqlAuditFile(entrypointBytes.toString('utf8'), inventory.configuredEntrypoint).callsites
    .filter(row => (row.referencedObjects || []).includes('events') ||
      (row.statementDetails || []).some(item => (item.referencedObjects || []).includes('events')));
  const eventRows = [...preservedRows, ...currentEntrypointRows];
  const entries = eventRows.map(row => {
    const sourcePath = path.join(root, row.file);
    const sourceBytes = fs.readFileSync(sourcePath);
    const sourceSha256 = sha256(sourceBytes);
    if (row.file !== inventory.configuredEntrypoint && fileHashes.get(row.file) !== sourceSha256) {
      throw new Error(`source drift against preserved SQL inventory: ${row.file}`);
    }
    const entry = classifyQuery(row, root);
    entry.source.sourceSha256 = sourceSha256;
    return entry;
  });
  const operationCounts = Object.fromEntries([...new Set(entries.map(entry => entry.operation))]
    .sort().map(key => [key, entries.filter(entry => entry.operation === key).length]));
  return {
    schemaVersion: 1,
    registerId,
    status: 'source-query-shape-classification-not-projection-manifest',
    sourceInventory: input,
    sourceInventorySha256: sha256(fs.readFileSync(inventoryPath)),
    sourceDrift: preservedEntrypointSha256 === entrypointSha256 ? [] : [{
      file: inventory.configuredEntrypoint,
      preservedSha256: preservedEntrypointSha256,
      currentSha256: entrypointSha256,
      handling: 're-extracted event SQL callsites from this changed entrypoint only; the six unchanged runtime files reuse preserved inventory rows'
    }],
    configuredEntrypoint: inventory.configuredEntrypoint,
    scope: 'configured entrypoint + src/runtime; scripts excluded from runtime callsite count',
    counts: { eventSqlCallsites: entries.length, sourceFiles: new Set(entries.map(entry => entry.source.file)).size, operations: operationCounts },
    limitations: [
      'Derived from a preserved lexical SQL callsite inventory; not an AST or complete call graph.',
      'Query shape and literal type selectors are source facts, not authorization semantics.',
      'predicateColumns are lexical WHERE-clause references, not AST-resolved predicates; JOIN ON selectors and nested-query structure may require manual review.',
      'Parameterized type values, caller bindings, transaction context, replay meaning and projection membership require manual call-chain review.',
      'Does not cover aliases, wrappers, generated SQL, non-SQL writers, historical rows or deployed processes.',
      'Does not define an event allowlist, projection manifest, schema version or runtime authorization policy.'
    ],
    entries
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outputIndex = process.argv.indexOf('--output');
    const inventoryIndex = process.argv.indexOf('--inventory');
    const idIndex = process.argv.indexOf('--register-id');
    const inventory = inventoryIndex >= 0 ? process.argv[inventoryIndex + 1] : INPUT;
    const registerId = idIndex >= 0 ? process.argv[idIndex + 1] : 'agg-v2-event-query-register-20261030-v0.4';
    if (inventoryIndex >= 0 && !inventory) throw new Error('--inventory requires a path');
    if (idIndex >= 0 && !registerId) throw new Error('--register-id requires a value');
    const register = buildEventQueryRegister(ROOT, inventory, registerId);
    const json = `${JSON.stringify(register, null, 2)}\n`;
    if (outputIndex >= 0) {
      const output = process.argv[outputIndex + 1];
      if (!output) throw new Error('--output requires a path');
      const target = path.resolve(ROOT, output);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, json, { flag: 'wx', mode: 0o600 });
      process.stdout.write(`Wrote ${path.relative(ROOT, target)} (${register.counts.eventSqlCallsites} event SQL callsites)\n`);
    } else {
      process.stdout.write(`${JSON.stringify(register.counts)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
