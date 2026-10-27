import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serializePluginPackageMetadata } from '../scripts/plugin-package-metadata.mjs';
import { PHASE2_BUILDER_RECEIPT_CONTRACT, PHASE2_MANIFEST_CONTRACT,
  verifyPhase2CustodyEvidence } from '../scripts/lib/phase2-custody-evidence.mjs';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function signed(payload, privateKey) {
  return { ...payload, signature_base64: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64') };
}
function fingerprint(publicKey) { return sha256(publicKey.export({ type: 'spki', format: 'der' })); }
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-custody-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); const payloadDir = path.join(dir, 'payload');
  fs.mkdirSync(repo); fs.mkdirSync(payloadDir);
  fs.mkdirSync(path.join(repo, 'plugin'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'custody fixture\n');
  fs.writeFileSync(path.join(repo, 'plugin/manifest.json'), '{"name":"fixture","tools":[]}\n');
  const packageSource = { name: 'fixture', version: '1.0.0', description: 'fixture package', runtimeEntryPoint: 'index.js' };
  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify(packageSource, null, 2)}\n`);
  const paths = ['README.md', 'manifest.json', 'package.json'];
  for (let i = 0; i < 68; i++) {
    const name = `payload/file-${String(i).padStart(2, '0')}.txt`;
    fs.mkdirSync(path.join(repo, 'payload'), { recursive: true });
    fs.writeFileSync(path.join(repo, name), `content ${i}\n`);
    paths.push(name);
  }
  paths.sort();
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'custody fixture']);
  const commit = git(repo, 'rev-parse', 'HEAD'); const tree = git(repo, 'rev-parse', `${commit}^{tree}`);
  for (const name of paths) {
    const sourcePath = name === 'manifest.json' ? 'plugin/manifest.json' : name;
    let bytes;
    if (name === 'package.json') bytes = serializePluginPackageMetadata(packageSource);
    else bytes = fs.readFileSync(path.join(repo, sourcePath));
    const target = path.join(payloadDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  const candidatePath = path.join(dir, 'candidate.mcpb');
  execFileSync('zip', ['-q', '-X', candidatePath, ...paths], { cwd: payloadDir });
  const candidateBytes = fs.readFileSync(candidatePath);
  const sourceSnapshotSha256 = sha256(execFileSync('git', ['-C', repo, 'archive', '--format=tar', commit]));
  const authority = generateKeyPairSync('ed25519'); const builder = generateKeyPairSync('ed25519');
  const authorityPem = authority.publicKey.export({ type: 'spki', format: 'pem' });
  const builderPem = builder.publicKey.export({ type: 'spki', format: 'pem' });
  const manifestPayload = { schema_version: 1, contract: PHASE2_MANIFEST_CONTRACT, authority_id: 'phase2-owner-test',
    repository: 'https://example.invalid/repo', source_commit: commit, source_tree_oid: tree,
    issued_at: '2026-10-27T11:00:00.000Z', paths };
  const manifestBytes = Buffer.from(`${JSON.stringify(signed(manifestPayload, authority.privateKey), null, 2)}\n`);
  const manifestPath = path.join(dir, 'manifest.json'); fs.writeFileSync(manifestPath, manifestBytes);
  const receipt = signed({ schema_version: 1, contract: PHASE2_BUILDER_RECEIPT_CONTRACT,
    builder_identity: 'https://builder.example.invalid/phase2', repository: manifestPayload.repository,
    source_commit: commit, source_tree_oid: tree, source_snapshot_sha256: sourceSnapshotSha256,
    candidate_sha256: sha256(candidateBytes), candidate_size_bytes: candidateBytes.length,
    manifest_sha256: sha256(manifestBytes), built_at: '2026-10-27T11:30:00.000Z', invocation_id: 'build-fixture-0001' }, builder.privateKey);
  const receiptPath = path.join(dir, 'receipt.json'); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const args = { repositoryRoot: repo, candidatePath, manifestPath, receiptPath,
    authorityPublicKeyPem: authorityPem, builderPublicKeyPem: builderPem,
    expectedAuthorityKeySha256: fingerprint(authority.publicKey), expectedBuilderKeySha256: fingerprint(builder.publicKey),
    expectedAuthorityId: 'phase2-owner-test', expectedBuilderIdentity: 'https://builder.example.invalid/phase2',
    expectedRepository: manifestPayload.repository, now: NOW };
  return { ...args, dir, paths, authority, builder, manifestPayload, receipt };
}

test('verifies signed authoritative 71-path manifest, builder receipt, source snapshot and exact archive bytes without granting production authority', t => {
  const value = fixture(t);
  const result = verifyPhase2CustodyEvidence(value);
  assert.equal(result.status, 'CRYPTOGRAPHIC_AND_SOURCE_BINDINGS_VERIFIED');
  assert.equal(result.manifestPathCount, 71);
  assert.equal(result.signatureVerification.manifest, true);
  assert.equal(result.signatureVerification.builderReceipt, true);
  assert.equal(result.productionAuthorityEstablished, false);
  assert.equal(result.trustRootProvisioningAuthenticated, false);
  assert.ok(result.blockers.includes('EXTERNAL_MONOTONIC_CHECKPOINT_NOT_VERIFIED'));
});

test('rejects a changed candidate even when caller retains the old signed builder receipt', t => {
  const value = fixture(t);
  fs.appendFileSync(value.candidatePath, Buffer.from('tamper'));
  assert.throws(() => verifyPhase2CustodyEvidence(value), /PHASE2_CUSTODY_RECEIPT_BINDING_MISMATCH/);
});

test('rejects authority/builder trust-root collision and a caller-supplied fingerprint mismatch', t => {
  const value = fixture(t);
  assert.throws(() => verifyPhase2CustodyEvidence({ ...value, builderPublicKeyPem: value.authorityPublicKeyPem,
    expectedBuilderKeySha256: value.expectedAuthorityKeySha256 }), /PHASE2_CUSTODY_TRUST_ROOT_COLLISION/);
  assert.throws(() => verifyPhase2CustodyEvidence({ ...value, expectedAuthorityKeySha256: '0'.repeat(64) }), /PHASE2_CUSTODY_KEY_PIN_MISMATCH/);
});

test('rejects altered receipt fields, including candidate binding and source snapshot digest', t => {
  const value = fixture(t);
  const receiptPath = path.join(value.dir, 'bad-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify({ ...value.receipt, source_snapshot_sha256: '0'.repeat(64) }));
  assert.throws(() => verifyPhase2CustodyEvidence({ ...value, receiptPath }), /PHASE2_CUSTODY_SIGNATURE_INVALID/);
});

test('rejects a signed manifest that does not preserve the frozen 71-path contract', t => {
  const value = fixture(t);
  const payload = { ...value.manifestPayload, paths: value.paths.slice(1) };
  const bytes = Buffer.from(`${JSON.stringify(signed(payload, value.authority.privateKey), null, 2)}\n`);
  const manifestPath = path.join(value.dir, 'short-manifest.json'); fs.writeFileSync(manifestPath, bytes);
  const receiptPath = path.join(value.dir, 'short-receipt.json');
  const { signature_base64: ignored, ...receiptPayload } = value.receipt;
  const receipt = signed({ ...receiptPayload, manifest_sha256: sha256(bytes) }, value.builder.privateKey);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => verifyPhase2CustodyEvidence({ ...value, manifestPath, receiptPath }), /PHASE2_CUSTODY_MANIFEST_INVALID/);
});
