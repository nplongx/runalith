#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../src/runtime/workflow/plan.js';

const rustRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(rustRoot, 'crates/runalith-domain/tests/fixtures/node-plan-canonical-json-v1.json');
const outputPath = path.resolve(process.argv[2] || defaultOutput);

const inputs = [
  {
    name: 'nested-object-insertion-order',
    input_json: '{"z":1,"a":{"y":2,"b":3},"items":[{"z":0,"a":true},null,"text"]}'
  },
  {
    name: 'prototype-sensitive-own-key',
    input_json: '{"workflow_id":"proto-key-test","__proto__":{"authority":"untrusted","nested":{"z":2,"a":1}}}'
  },
  {
    name: 'unicode-utf16-key-order',
    input_json: '{"\\uE000":1,"😀":2,"a":3,"é":4,"é":5}'
  },
  {
    name: 'safe-integer-boundaries-and-negative-zero',
    input_json: '{"max":9007199254740991,"min":-9007199254740991,"zero":-0.0,"nested":[0,1,-1]}'
  },
  {
    name: 'json-string-escaping-and-unicode-preservation',
    input_json: '{"slash":"/","quote":"\\\"","backslash":"\\\\","line":"first\\nsecond","control":"\\u000f","unicode":"é / é / 😀"}'
  },
  {
    name: 'empty-and-null-shapes',
    input_json: '{"empty_object":{},"empty_array":[],"empty_string":"","null_value":null,"false_value":false,"true_value":true}'
  }
];

const vectors = inputs.map(({ name, input_json }) => {
  const value = JSON.parse(input_json);
  const canonical = canonicalJson(value);
  return {
    name,
    input_json,
    canonical_json: canonical,
    sha256: createHash('sha256').update(canonical, 'utf8').digest('hex')
  };
});

const fixture = {
  schema_version: 1,
  generated_by_node: true,
  source: 'src/runtime/workflow/plan.js::canonicalJson',
  numeric_contract: 'finite safe integers; fractional and unsafe values are outside this Rust adapter contract',
  vectors
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ output: outputPath, vectors: vectors.length, sha256: vectors.map(({ name, sha256 }) => ({ name, sha256 })) }, null, 2));
