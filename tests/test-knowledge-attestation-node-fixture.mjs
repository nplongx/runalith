import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  canonicalAdaptiveGoalKnowledgeJson,
  ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE
} from '../src/runtime/adaptive-goal-knowledge-verifier.js';
import { adaptiveGoalPublicKeyFingerprint } from '../src/runtime/adaptive-goal-trust-configuration.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/knowledge-attestation-v1-node.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('Node knowledge-attestation golden fixture preserves exact Ed25519 bytes and cross-runtime identities', () => {
  assert.equal(fixture.fixture_version, 1);
  assert.equal(fixture.now, '2026-11-02T09:10:00.000Z');

  const configuration = JSON.parse(fixture.trust_config_json);
  assert.equal(configuration.domain, 'goal_idea_verifier');
  assert.equal(configuration.keys.length, 1);
  assert.deepEqual(configuration.keys[0].scopes, [ADAPTIVE_GOAL_KNOWLEDGE_VERIFICATION_SCOPE]);

  const publicKey = createPublicKey(configuration.keys[0].public_key_pem);
  assert.equal(adaptiveGoalPublicKeyFingerprint(publicKey), fixture.trust_root_sha256);

  const receipt = JSON.parse(fixture.receipt_json);
  const subject = JSON.parse(fixture.subject_json);
  const unsigned = { ...receipt };
  delete unsigned.signature;
  const canonicalUnsigned = canonicalAdaptiveGoalKnowledgeJson(unsigned);
  assert.equal(canonicalUnsigned, fixture.signature_input_json);
  assert.equal(
    verify(null, Buffer.from(canonicalUnsigned, 'utf8'), publicKey, Buffer.from(receipt.signature, 'base64')),
    true
  );

  const canonicalReceipt = canonicalAdaptiveGoalKnowledgeJson(receipt);
  const canonicalSubject = canonicalAdaptiveGoalKnowledgeJson(subject);
  assert.equal(sha256(canonicalReceipt), fixture.receipt_sha256);
  assert.equal(sha256(canonicalSubject), fixture.subject_sha256);
  assert.equal(
    sha256(`${receipt.goal_id}|${receipt.snapshot_hash}|${receipt.provider_id}|${receipt.nonce}|${receipt.evidence_manifest_hash}`),
    fixture.attestation_id
  );
  assert.equal(`${receipt.provider_id}/${configuration.keys[0].key_id}`, fixture.verifier_id);
});
