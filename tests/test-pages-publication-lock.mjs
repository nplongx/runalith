import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
const ciWorkflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const site = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');

test('Pages builds and validates locally but publication remains fail-closed until independent release gates exist', () => {
  assert.match(workflow, /name: Deploy GitHub Pages/);
  assert.match(workflow, /run: npm run docs:check/);
  assert.match(workflow, /run: node scripts\/build-static-site\.mjs/);
  assert.match(workflow, /run: npm run site:check/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v5/);
  assert.match(workflow, /deploy:\s*[\s\S]*?if:\s*\$\{\{\s*false\s*\}\}/,
    'deploy must remain unconditionally disabled while release blockers lack independent workflow evidence');
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /host-owned verifier\/reviewer authority[\s\S]*protected external monotonic checkpoint evidence/,
    'the lock must document the independent release evidence required before deployment is reconsidered');
  assert.match(ciWorkflow, /node --test tests\/test-external-trust-checkpoint-contract\.mjs/,
    'CI must run the external checkpoint freshness, signature, anti-replay and continuity contract');
  assert.match(ciWorkflow, /npm run test:package-reproducibility/,
    'CI must verify reproducible package inputs and exact archive bytes');
  assert.match(ciWorkflow, /git diff --check "\$BASE_SHA" HEAD[\s\S]*?git diff --check HEAD\^ HEAD/,
    'CI whitespace validation must cover the full PR/push range when its base is available, not only the last commit');
  assert.match(site, /id="release-status"[\s\S]*?<div class="feature-label">FAIL<\/div>[\s\S]*?Frozen Phase-2 lineage[\s\S]*?<div class="feature-label">BLOCKED<\/div>[\s\S]*?Production authority/,
    'the generated site must disclose lineage FAIL and production-authority BLOCKED in its release-status section');
  assert.match(site, /no production-authorized release, installation, activation, or publication/i,
    'the generated site must not imply release readiness or publication while mandatory gates are open');
});
