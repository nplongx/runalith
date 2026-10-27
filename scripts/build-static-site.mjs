#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(repoRoot, 'scripts', 'templates', 'site-index.html');
const siteIndexPath = path.join(repoRoot, 'site', 'index.html');
const packagePath = path.join(repoRoot, 'package.json');
const mcpReferencePath = path.join(repoRoot, 'docs', 'MCP_REFERENCE.md');
const docsDirectory = path.join(repoRoot, 'docs');

function fail(message) {
  const error = new Error(`STATIC_SITE_BUILD_INVALID: ${message}`);
  error.code = 'STATIC_SITE_BUILD_INVALID';
  throw error;
}

function readUtf8(filePath, description) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (error) { fail(`${description} cannot be read: ${error.message}`); }
}

export function getStaticSiteInputs() {
  const packageJson = JSON.parse(readUtf8(packagePath, 'package.json'));
  if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
    fail('package.json version is missing or malformed');
  }
  const entryPoint = packageJson.runtimeEntryPoint;
  if (typeof entryPoint !== 'string' || !entryPoint || path.isAbsolute(entryPoint) ||
      entryPoint.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    fail('package.json runtimeEntryPoint must be a safe, relative path');
  }
  const entryPointPath = path.resolve(repoRoot, entryPoint);
  if (!entryPointPath.startsWith(`${repoRoot}${path.sep}`) || !fs.existsSync(entryPointPath) || !fs.statSync(entryPointPath).isFile()) {
    fail(`declared runtime entry point does not exist inside the repository: ${entryPoint}`);
  }

  const reference = readUtf8(mcpReferencePath, 'generated MCP reference');
  const referenceVersion = /^- Source package version reported at generation time: `([^`]+)`/m.exec(reference)?.[1];
  if (referenceVersion !== packageJson.version) {
    fail(`MCP reference version ${referenceVersion || '<missing>'} does not match package.json ${packageJson.version}; run npm run docs:generate-reference`);
  }
  const declaredToolCount = Number(/^- Registered tools: \*\*(\d+)\*\*\.$/m.exec(reference)?.[1]);
  const toolHeadingCount = (reference.match(/^### `[^`]+`$/gm) || []).length;
  if (!Number.isSafeInteger(declaredToolCount) || declaredToolCount < 1 || declaredToolCount !== toolHeadingCount) {
    fail(`MCP reference inventory is inconsistent (declared=${declaredToolCount || 'missing'}, headings=${toolHeadingCount})`);
  }

  const rcVersion = /-rc\.(\d+)$/.exec(packageJson.version)?.[1] || null;
  const acceptancePrefix = rcVersion ? `goal-plan-execution-acceptance-rc${rcVersion}-` : null;
  const acceptanceFiles = acceptancePrefix
    ? fs.readdirSync(docsDirectory).filter(name => name.startsWith(acceptancePrefix) && name.endsWith('.md')).sort()
    : [];
  if (acceptanceFiles.length === 0) {
    fail(`no version-specific acceptance document found for ${packageJson.version} (expected docs/${acceptancePrefix || 'goal-plan-execution-acceptance-rcN-'}*.md)`);
  }
  const acceptanceFilename = acceptanceFiles.at(-1);
  const acceptancePath = path.join(docsDirectory, acceptanceFilename);
  if (!fs.statSync(acceptancePath).isFile()) fail(`acceptance link target is not a file: docs/${acceptanceFilename}`);

  return {
    version: packageJson.version,
    runtimeEntryPoint: entryPoint,
    mcpToolCount: declaredToolCount,
    mcpReferenceVersion: referenceVersion,
    acceptanceFilename,
    template: readUtf8(templatePath, 'static site template')
  };
}

export function renderStaticSite() {
  const inputs = getStaticSiteInputs();
  const replacements = {
    '{{RUNALITH_VERSION}}': inputs.version,
    '{{RUNTIME_ENTRY_POINT}}': inputs.runtimeEntryPoint,
    '{{MCP_TOOL_COUNT}}': String(inputs.mcpToolCount),
    '{{ACCEPTANCE_DOC_FILENAME}}': inputs.acceptanceFilename
  };
  let output = inputs.template;
  for (const [marker, replacement] of Object.entries(replacements)) {
    if (!output.includes(marker)) fail(`template does not contain required marker ${marker}`);
    output = output.replaceAll(marker, replacement);
  }
  const remaining = /\{\{[A-Z0-9_]+\}\}/.exec(output);
  if (remaining) fail(`unresolved template marker ${remaining[0]}`);
  if (!output.endsWith('\n') || output.endsWith('\n\n')) fail('rendered HTML must contain exactly one terminal newline');
  return output;
}

function main() {
  const output = renderStaticSite();
  const existing = fs.existsSync(siteIndexPath) ? fs.readFileSync(siteIndexPath, 'utf8') : null;
  if (existing === output) {
    process.stdout.write(`Static site build unchanged: ${path.relative(repoRoot, siteIndexPath)} (${getStaticSiteInputs().version})\n`);
    return;
  }
  fs.writeFileSync(siteIndexPath, output, { encoding: 'utf8', mode: 0o644 });
  process.stdout.write(`Static site built from ${path.relative(repoRoot, templatePath)}: ${path.relative(repoRoot, siteIndexPath)} (${getStaticSiteInputs().version})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.code || 'STATIC_SITE_BUILD_FAILED'}: ${String(error.message || error)}\n`);
    process.exitCode = 2;
  }
}
