// Development-only schema compatibility shim for local Ollama grammar limits.
// It changes only the model-visible copy; it must never rewrite MCP/runtime
// schemas or the frozen scenario/candidate bytes.
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function collectOneOfPaths(value, pointer = '$.function.parameters', paths = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectOneOfPaths(item, `${pointer}/${index}`, paths));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'oneOf' && Array.isArray(item)) paths.push(`${pointer}/oneOf`);
      collectOneOfPaths(item, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, paths);
    }
  }
  return paths;
}

/**
 * Produce a model-visible tool definition compatible with the known local
 * Ollama grammar failure. The actual MCP server still receives the original
 * arguments and remains authoritative for input validation.
 */
export function normalizeOllamaPluginTool(tool) {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !tool.inputSchema) {
    throw new TypeError('expected an MCP tool with name and inputSchema');
  }
  const original = {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: structuredClone(tool.inputSchema),
    },
  };
  const normalized = structuredClone(original);
  const oneOfKeywordPathsOmitted = collectOneOfPaths(original.function.parameters);
  const omittedTopLevelProperties = [];
  let compatibilityRule = 'unchanged-schema-no-unsupported-oneOf';

  if (tool.name === 'workflow_create' && oneOfKeywordPathsOmitted.length > 0) {
    // The original 13 KB schema causes Ollama's grammar compiler to fail. A
    // union-flattened 4 KB version still fails; a minimal object schema does
    // not immediately fail grammar initialization. This dev-only projection
    // exposes required title/task and optional workspace/goal as plain strings,
    // deliberately dropping constraints/defaults/enums from the model-visible
    // copy. Runtime validation uses the untouched full MCP schema.
    const allowedProperties = ['title', 'task', 'workspace', 'goal'];
    const sourceProperties = original.function.parameters.properties ?? {};
    for (const key of Object.keys(sourceProperties)) {
      if (!allowedProperties.includes(key)) omittedTopLevelProperties.push(key);
    }
    normalized.function.parameters = {
      type: 'object',
      properties: Object.fromEntries(allowedProperties
        .filter(name => Object.hasOwn(sourceProperties, name))
        .map(name => {
          if (sourceProperties[name]?.type !== 'string') throw new TypeError(`workflow_create.${name} is not a string in the source schema`);
          return [name, { type: 'string' }];
        })),
      required: (original.function.parameters.required ?? []).filter(name => allowedProperties.includes(name)),
      additionalProperties: false,
    };
    normalized.function.description = `${original.function.description} Development-only local-Ollama compatibility: model-visible fields are limited to title, task, and simple optional goal/workspace fields. Complex optional fields are omitted from the model schema; the MCP server retains and enforces the complete original input schema.`;
    compatibilityRule = 'workflow-create-minimal-string-fields-for-local-ollama-grammar';
  } else if (oneOfKeywordPathsOmitted.length > 0) {
    throw new Error(`no reviewed Ollama schema compatibility rule for ${tool.name}; refusing to guess`);
  }

  const originalParametersJson = JSON.stringify(original.function.parameters);
  const normalizedParametersJson = JSON.stringify(normalized.function.parameters);
  return {
    tool: normalized,
    metadata: {
      toolName: tool.name,
      compatibilityRule,
      omittedTopLevelProperties,
      oneOfKeywordCount: oneOfKeywordPathsOmitted.length,
      oneOfKeywordPathsOmitted,
      originalParametersSha256: sha256(originalParametersJson),
      normalizedParametersSha256: sha256(normalizedParametersJson),
      originalParametersBytes: Buffer.byteLength(originalParametersJson),
      normalizedParametersBytes: Buffer.byteLength(normalizedParametersJson),
      runtimeSchemaModified: false,
      candidateBytesModified: false,
      officialAcceptanceEligible: false,
    },
  };
}
