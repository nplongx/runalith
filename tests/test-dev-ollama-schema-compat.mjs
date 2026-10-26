import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeOllamaPluginTool } from '../benchmarks/plugin-workflow-benchmark/dev-ollama-schema-compat.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('Ollama dev schema compatibility projects workflow_create to a minimal model-visible clone', () => {
  const tool = {
    name: 'workflow_create',
    description: 'Create a workflow proposal',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1 },
        task: { type: 'string', minLength: 1 },
        workflow: { type: 'string', enum: ['standard-engineering', 'production'] },
        workspace: { type: 'string' },
        goal: { type: 'string' },
        constraints: { type: 'array', items: { oneOf: [
          { type: 'object', required: ['kind'], properties: { kind: { const: 'present' } } },
          { type: 'object', required: ['kind'], properties: { kind: { const: 'absent' } } },
        ] } },
        nested: { type: 'object', properties: { required: { oneOf: [{ type: 'string' }, { type: 'number' }] } } },
      },
      required: ['title', 'task', 'constraints'],
    },
  };
  const originalBytes = JSON.stringify(tool.inputSchema);
  const result = normalizeOllamaPluginTool(tool);

  assert.equal(JSON.stringify(tool.inputSchema), originalBytes, 'the discovered MCP schema must remain immutable');
  assert.equal(result.tool.function.name, tool.name);
  assert.equal(result.metadata.compatibilityRule, 'workflow-create-minimal-string-fields-for-local-ollama-grammar');
  assert.equal(result.metadata.oneOfKeywordCount, 2);
  assert.equal(result.metadata.originalParametersSha256, sha256(originalBytes));
  assert.notEqual(result.metadata.originalParametersSha256, result.metadata.normalizedParametersSha256);
  assert.equal(result.metadata.runtimeSchemaModified, false);
  assert.equal(result.metadata.candidateBytesModified, false);
  assert.equal(result.metadata.officialAcceptanceEligible, false);
  assert.deepEqual(Object.keys(result.tool.function.parameters.properties), ['title', 'task', 'workspace', 'goal']);
  assert.deepEqual(result.tool.function.parameters.properties.title, { type: 'string' });
  assert.deepEqual(result.tool.function.parameters.properties.task, { type: 'string' });
  assert.deepEqual(result.tool.function.parameters.required, ['title', 'task']);
  assert.ok(result.metadata.omittedTopLevelProperties.includes('constraints'));
  assert.ok(result.metadata.omittedTopLevelProperties.includes('nested'));
  assert.ok(result.metadata.omittedTopLevelProperties.includes('workflow'));
});

test('ordinary tool schemas pass through with identical parameter hash and no keyword removals', () => {
  const tool = { name: 'workflow_get', inputSchema: {
    type: 'object', properties: { job_id: { type: 'string', minLength: 1 } },
    required: ['job_id'], additionalProperties: false,
  } };
  const result = normalizeOllamaPluginTool(tool);
  assert.equal(result.metadata.oneOfKeywordCount, 0);
  assert.deepEqual(result.tool.function.parameters, tool.inputSchema);
  assert.equal(result.metadata.originalParametersSha256, result.metadata.normalizedParametersSha256);
  assert.equal(result.metadata.originalParametersBytes, result.metadata.normalizedParametersBytes);
});

test('normalizer rejects malformed MCP tool definitions instead of guessing', () => {
  assert.throws(() => normalizeOllamaPluginTool(null), /expected an MCP tool/);
  assert.throws(() => normalizeOllamaPluginTool({ name: 'workflow_create' }), /expected an MCP tool/);
  assert.throws(() => normalizeOllamaPluginTool({ name: 'other_tool', inputSchema: { oneOf: [{ type: 'string' }] } }), /no reviewed Ollama schema compatibility rule/);
});
