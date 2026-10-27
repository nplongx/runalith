import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const builder = fs.readFileSync(path.join(root, '.github/workflows/runalith-provenance-builder.yml'), 'utf8');
const verifier = fs.readFileSync(path.join(root, '.github/workflows/runalith-provenance-verifier.yml'), 'utf8');
const verifierSigner = fs.readFileSync(path.join(root, '.github/workflows/runalith-verification-attestation-signer.yml'), 'utf8');
const policySha256 = '86a16eba1acf77a4966fc18ab45d450638f474faa0060d2964df2915741e843e';

function section(text, start, end) {
  const first = text.indexOf(start);
  assert.notEqual(first, -1, `workflow section missing: ${start}`);
  const last = text.indexOf(end, first + start.length);
  assert.notEqual(last, -1, `workflow section end missing after ${start}: ${end}`);
  return text.slice(first, last);
}

test('builder build/test job is low privilege and pinned to protected main', () => {
  assert.match(builder, /on:\s*\n\s+workflow_dispatch:/);
  const build = section(builder, '  build-and-test:', '  attest-exact-build:');
  assert.match(build, /github\.ref == 'refs\/heads\/main' && github\.ref_protected/);
  assert.match(build, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(build, /id-token:\s*write|attestations:\s*write|artifact-metadata:\s*write/);
  assert.match(build, /npm test/);
  assert.match(build, /npm run test:package-reproducibility/);
  assert.match(build, /scripts\/verify-mcpb-source-alignment\.mjs/);
  assert.match(build, /npm run test:mcpb-candidate/);
  assert.match(build, /sourceGitState\?\.workingTreeClean !== true/);
});

test('builder signing job handles opaque candidate data only and cannot execute candidate code', () => {
  const signing = section(builder, '  attest-exact-build:', '      - name: State the release boundary explicitly');
  assert.match(signing, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(signing, /actions\/attest@[a-f0-9]{40}/);
  assert.match(signing, /subject-path:/);
  assert.doesNotMatch(signing, /actions\/checkout|npm (ci|test|install)|unzip -|bash scripts\/package-runalith/);
  assert.match(builder, /PRODUCTION_RELEASE_AUTHORITY=BLOCKED/);
});

test('independent verifier re-tests/rebuilds the exact source commit and checks reproducible candidate bytes', () => {
  const verify = section(verifier, '  independently-verify:', '      - name: Report the authority boundary');
  assert.match(verify, /workflow_run\.head_sha/);
  assert.match(verify, /ref: \$\{\{ env\.BUILDER_SHA \}\}/);
  assert.match(verify, /npm test/);
  assert.match(verify, /node --test tests\/test-hosted-builder-attestation\.mjs tests\/test-hosted-verification-predicate\.mjs \\\s+tests\/test-runalith-release-trust-contract\.mjs tests\/test-runalith-hosted-workflows\.mjs/);
  assert.match(verify, /independent-rebuild\.mcpb/);
  assert.match(verify, /PASS_BYTE_IDENTICAL/);
  assert.match(verify, /independent-source-alignment\.json/);
  assert.match(verify, /gh attestation verify|verify-hosted-builder-provenance\.mjs/);
  assert.match(verify, /create-hosted-candidate-verification-predicate\.mjs/);
  assert.match(verify, /candidate-verification-predicate\.json/);
  assert.doesNotMatch(verify, /id-token:\s*write|attestations:\s*write|artifact-metadata:\s*write/);
  assert.doesNotMatch(verifier, /attest-verifier-decision:/, 'the verifier and verifier-signer must be separate workflows/identities');
});

test('verifier predicate is signed by a third workflow identity with no checkout/npm/candidate execution', () => {
  assert.match(verifierSigner, /workflows:\s*\[Runalith independent provenance verifier\]/);
  assert.match(verifierSigner, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(verifierSigner, /permissions:[\s\S]*?id-token: write[\s\S]*?attestations: write[\s\S]*?artifact-metadata: write/);
  assert.match(verifierSigner, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(verifierSigner, /actions\/attest@[a-f0-9]{40}/);
  assert.match(verifierSigner, /predicate-type: https:\/\/runalith\.dev\/attestations\/hosted-candidate-verification\/v1/);
  assert.match(verifierSigner, /predicate-path:/);
  assert.match(verifierSigner, /--bundle/);
  assert.match(verifierSigner, /--repo nplongx\/runalith/);
  assert.match(verifierSigner, new RegExp(`POLICY_SHA256: ${policySha256}`));
  assert.match(verifierSigner, /candidate-verification-predicate\.json/);
  assert.match(verifierSigner, /productionReleaseEligible: false/);
  assert.doesNotMatch(verifierSigner, /actions\/checkout|npm (ci|test|install)|unzip -|bash scripts\/package-runalith/);
  assert.match(verifierSigner, /PRODUCTION_ROLLOUT=BLOCKED/);
});

test('all referenced GitHub actions are pinned to full immutable commit SHAs', () => {
  for (const [name, workflow] of [['builder', builder], ['verifier', verifier], ['verifier-signer', verifierSigner]]) {
    const references = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(match => match[1]);
    assert.ok(references.length >= (name === 'verifier-signer' ? 2 : 4), `${name} workflow should use pinned first-party actions`);
    for (const reference of references) {
      assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/, `${name}: action ref must pin a full SHA: ${reference}`);
    }
  }
});

test('pinned verifier policy digest matches the exact versioned JSON policy bytes', () => {
  const policyBytes = fs.readFileSync(path.join(root, 'scripts/runalith-hosted-build-policy.json'));
  const actual = createHash('sha256').update(policyBytes).digest('hex');
  assert.equal(actual, policySha256);
  assert.match(verifierSigner, new RegExp(`POLICY_SHA256: ${actual}`));
});
