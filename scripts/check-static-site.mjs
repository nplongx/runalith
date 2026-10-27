#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getStaticSiteInputs, renderStaticSite } from './build-static-site.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = path.join(repoRoot, 'site');
const EXTERNAL_LINK_TIMEOUT_MS = 8_000;
const REQUIRED_ASSETS = ['index.html', 'styles.css', 'logo.svg', '404.html', '.nojekyll'];
const URL_ATTRIBUTES = /\b(href|src)\s*=\s*(["'])(.*?)\2/gi;
const ID_ATTRIBUTE = /\bid\s*=\s*(["'])(.*?)\1/gi;

function fail(message) {
  const error = new Error(`STATIC_SITE_CHECK_FAILED: ${message}`);
  error.code = 'STATIC_SITE_CHECK_FAILED';
  throw error;
}

function read(filePath, description) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (error) { fail(`${description} cannot be read: ${error.message}`); }
}

function parseAttributes(html, regex) {
  return [...html.matchAll(regex)].map(match => ({ name: match[1].toLowerCase(), value: match[3] ?? match[2] }));
}

function idSetForHtml(html, relativePath) {
  const found = [...html.matchAll(ID_ATTRIBUTE)].map(match => match[2]);
  const ids = new Set();
  for (const id of found) {
    if (!id) fail(`${relativePath} has an empty id attribute`);
    if (ids.has(id)) fail(`${relativePath} has duplicate id #${id}`);
    ids.add(id);
  }
  return ids;
}

function localTarget(currentRelativePath, rawUrl) {
  let url;
  try { url = new URL(rawUrl, `https://runalith-site-validation.invalid/${currentRelativePath}`); }
  catch { fail(`${currentRelativePath} contains a malformed URL: ${rawUrl}`); }
  if (url.origin !== 'https://runalith-site-validation.invalid') return { external: url };
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); }
  catch { fail(`${currentRelativePath} contains an invalid URL escape: ${rawUrl}`); }
  const absolute = path.resolve(siteRoot, `.${decodedPath}`);
  const relative = path.relative(siteRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${currentRelativePath} link escapes site root: ${rawUrl}`);
  }
  let target = absolute;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  return { external: null, target, relativeTarget: path.relative(siteRoot, target), anchor: decodeURIComponent(url.hash.slice(1)) };
}

function validateExternalUrl(url, sourcePath, rawUrl) {
  if (!['https:', 'mailto:'].includes(url.protocol)) {
    fail(`${sourcePath} contains a non-HTTPS external link (${url.protocol}): ${rawUrl}`);
  }
  if (url.protocol === 'https:' && (!url.hostname || url.username || url.password)) {
    fail(`${sourcePath} contains an unsafe HTTPS URL: ${rawUrl}`);
  }
  if (url.protocol === 'mailto:' && !url.pathname.includes('@')) {
    fail(`${sourcePath} contains a malformed mailto URL: ${rawUrl}`);
  }
}

function collectHtmlFiles(directory = siteRoot, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail(`site contains a symbolic link, which makes the deployment artifact ambiguous: ${path.join(prefix, entry.name)}`);
    const relative = path.join(prefix, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) files.push(...collectHtmlFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) files.push(relative);
  }
  return files.sort();
}

function checkSite() {
  const inputs = getStaticSiteInputs();
  for (const name of REQUIRED_ASSETS) {
    const file = path.join(siteRoot, name);
    assert.ok(fs.existsSync(file) && fs.statSync(file).isFile(), `missing static site asset: ${name}`);
  }
  const templatePath = path.join(repoRoot, 'scripts', 'templates', 'site-index.html');
  const template = read(templatePath, 'static site template');
  for (const marker of ['{{RUNALITH_VERSION}}', '{{RUNTIME_ENTRY_POINT}}', '{{MCP_TOOL_COUNT}}', '{{ACCEPTANCE_DOC_FILENAME}}']) {
    assert.ok(template.includes(marker), `site template must include dynamic input marker ${marker}`);
  }
  const html = read(path.join(siteRoot, 'index.html'), 'generated homepage');
  const expectedHtml = renderStaticSite();
  assert.equal(html, expectedHtml,
    'site/index.html is stale or edited by hand; run npm run site:build to regenerate from the checked-in template and versioned source inputs');
  const notFound = read(path.join(siteRoot, '404.html'), '404 page');
  const css = read(path.join(siteRoot, 'styles.css'), 'stylesheet');
  const combined = `${html}\n${notFound}\n${css}`;

  assert.match(html, /<html\s+lang="en">/i, 'site should declare its language');
  assert.match(html, /<meta\s+name="description"/i, 'site should declare a search description');
  assert.match(html, /<link\s+rel="canonical"\s+href="https:\/\/nplongx\.github\.io\/runalith\/"/i,
    'site canonical URL should match project Pages URL');
  assert.match(html, /<meta\s+property="og:url"\s+content="https:\/\/nplongx\.github\.io\/runalith\/"/i,
    'OpenGraph URL should match project Pages URL');
  assert.match(html, /\.mcpb/i, 'site should explain the MCP bundle format');
  assert.match(html, /https:\/\/github\.com\/nplongx\/runalith/, 'site must link to the current repository');
  assert.match(html, /href="styles\.css"/, 'site should use a relative stylesheet path');
  assert.match(html, /src="logo\.svg"/, 'site should use the shared Runalith logo asset');
  assert.match(html, /id="agg"/i, 'site should include the AGG system section');
  assert.match(html, /adaptive goal graph/i, 'site should explain Adaptive Goal Graph');
  assert.match(html, /Goal\/Idea/i, 'site should mention the Goal/Idea knowledge graph');
  assert.match(html, /Plan Graph/i, 'site should mention Plan Graph');
  assert.match(html, /Execution Graph/i, 'site should mention Execution Graph');
  assert.match(html, /owner\/provider reconciliation/i, 'site should describe operational reconciliation blockers');
  assert.match(html, /host-owned trust/i, 'site should describe the effective host trust requirement');
  assert.match(html, /independently protected external checkpoint/i, 'site should disclose independent monotonic checkpoint requirements');
  assert.match(html, /testing releases are experimental, not production certifications/i,
    'site should warn that experimental releases are not production certifications');
  assert.match(html, /Verify the downloaded package checksum/i, 'site should tell users to verify artifact checksums');
  assert.match(html, /quickstart\.md/, 'site should link to installation/client setup instructions');
  assert.match(html, new RegExp(inputs.runtimeEntryPoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'site example must use the declared package runtime entry point');
  assert.match(html, new RegExp(`Browse ${inputs.mcpToolCount} registered MCP tool definitions`),
    'site MCP tool count must come from the generated reference, not a hardcoded number');
  assert.match(html, new RegExp(inputs.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'site release label must match package.json');
  assert.match(html, new RegExp(inputs.acceptanceFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'site must link to the acceptance dossier for the source package version');
  assert.match(html, /id="release-status"/,
    'site must expose the current integration follow-up and release blockers alongside the historical acceptance dossier');
  assert.match(html, /Frozen Phase-2 lineage/i, 'site must disclose the unresolved historical source-lineage gate');
  assert.match(html, /Host-owned effective verifier\/reviewer configuration/i,
    'site must disclose the missing independent production trust and reconciliation evidence');
  assert.match(html, /no production-authorized release, installation, activation, or publication/i,
    'site must state the actual release decision rather than imply publication');
  assert.doesNotMatch(html, /\{\{[A-Z0-9_]+\}\}/, 'generated homepage must not retain template markers');
  assert.doesNotMatch(`${html}\n${notFound}`, /<script\b|<iframe\b|cdn\./i,
    'public site must remain static, framework-free HTML and must not load third-party scripts');
  assert.doesNotMatch(combined, /chat on steroids|chat-on-steroids/i, 'public site must use neutral Runalith branding');
  assert.match(notFound, /href="\.\/"/, '404 page should link back to the static site root');
  assert.ok(css.length > 1000, 'stylesheet unexpectedly empty');

  const htmlFiles = collectHtmlFiles();
  const idsByFile = new Map();
  for (const relative of htmlFiles) idsByFile.set(relative, idSetForHtml(read(path.join(siteRoot, relative), relative), relative));
  const externalUrls = new Set();
  let localLinksChecked = 0;
  let externalLinksChecked = 0;
  for (const relative of htmlFiles) {
    const sourceHtml = read(path.join(siteRoot, relative), relative);
    const attributes = [...sourceHtml.matchAll(URL_ATTRIBUTES)].map(match => ({ name: match[1].toLowerCase(), value: match[3] }));
    for (const attr of attributes) {
      const rawUrl = attr.value.trim();
      if (!rawUrl) fail(`${relative} contains an empty ${attr.name} attribute`);
      if (rawUrl.startsWith('data:')) {
        if (attr.name !== 'src' || !/^data:image\/(?:svg\+xml|png|jpeg|webp);/i.test(rawUrl)) {
          fail(`${relative} contains a non-image or unexpected data URL`);
        }
        continue;
      }
      const result = localTarget(relative, rawUrl);
      if (result.external) {
        validateExternalUrl(result.external, relative, rawUrl);
        externalUrls.add(result.external.href);
        externalLinksChecked += 1;
        continue;
      }
      localLinksChecked += 1;
      if (!fs.existsSync(result.target) || !fs.statSync(result.target).isFile()) {
        fail(`${relative} local ${attr.name} does not resolve to a file: ${rawUrl} (expected ${result.relativeTarget})`);
      }
      if (result.anchor) {
        if (!result.relativeTarget.toLowerCase().endsWith('.html')) {
          fail(`${relative} includes a fragment for a non-HTML local file: ${rawUrl}`);
        }
        const targetIds = idsByFile.get(result.relativeTarget);
        if (!targetIds?.has(result.anchor)) fail(`${relative} anchor does not resolve: ${rawUrl}`);
      }
    }
    for (const targetBlank of sourceHtml.matchAll(/<a\b([^>]*)\btarget=["']_blank["']([^>]*)>/gi)) {
      const linkAttrs = `${targetBlank[1]} ${targetBlank[2]}`;
      assert.match(linkAttrs, /\brel=["'][^"']*\bnoopener\b[^"']*["']/i,
        `${relative} target=_blank links must include rel=noopener`);
    }
  }
  return { version: inputs.version, htmlFiles, localLinksChecked, externalLinksChecked, uniqueExternalUrls: externalUrls.size,
    toolCount: inputs.mcpToolCount, runtimeEntryPoint: inputs.runtimeEntryPoint, acceptanceFilename: inputs.acceptanceFilename };
}

async function checkExternalUrls(urls) {
  const results = [];
  for (const url of [...urls].sort()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXTERNAL_LINK_TIMEOUT_MS);
    try {
      let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal,
        headers: { 'user-agent': 'Runalith-Static-Site-Link-Check/1.0' } });
      if ([403, 405, 429].includes(response.status)) {
        response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal,
          headers: { 'user-agent': 'Runalith-Static-Site-Link-Check/1.0', range: 'bytes=0-0' } });
      }
      results.push({ url, status: response.status, ok: response.status >= 200 && response.status < 400 });
      if (response.body) await response.body.cancel().catch(() => {});
    } catch (error) {
      results.push({ url, status: null, ok: false, error: String(error?.message || error) });
    } finally { clearTimeout(timeout); }
  }
  const failed = results.filter(result => !result.ok);
  if (failed.length) {
    for (const result of failed) process.stderr.write(`EXTERNAL_LINK_UNVERIFIED ${JSON.stringify(result)}\n`);
    fail(`${failed.length} of ${results.length} distinct external links could not be verified by HTTP`);
  }
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const doExternal = argv.includes('--check-external-links');
  const report = checkSite();
  if (doExternal) {
    // Derive URLs again from the actual published files to ensure the network
    // check tests exactly what deployment would publish.
    const urls = new Set();
    for (const relative of report.htmlFiles) {
      const html = read(path.join(siteRoot, relative), relative);
      for (const match of html.matchAll(URL_ATTRIBUTES)) {
        const value = match[3].trim();
        if (/^https:\/\//i.test(value)) urls.add(new URL(value).href);
      }
    }
    const checked = await checkExternalUrls(urls);
    report.externalHttpResults = { checked: checked.length, passed: checked.length };
  }
  process.stdout.write(`Static site check PASS ${JSON.stringify(report)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.code || 'STATIC_SITE_CHECK_FAILED'}: ${String(error.message || error)}\n`);
    process.exitCode = 2;
  });
}
