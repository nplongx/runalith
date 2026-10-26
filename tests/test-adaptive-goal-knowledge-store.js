import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAdaptiveGoalKnowledgeStore } from '../src/runtime/adaptive-goal-knowledge-store.js';

const db = new DatabaseSync(':memory:');
const store = createAdaptiveGoalKnowledgeStore(db);
const provenance = { source: 'unit-test', actor: 'test-suite' };
const create = (goalId, stableKey, type = 'idea', content = { z: 2, a: 1 }, expectedRevision = 0, evidenceRefs = []) => store.saveNode({
  goalId, stableKey, type, content, provenance, expectedRevision, evidenceRefs
});

try {
  const first = create('goal-a', 'shared-plan', 'idea', { z: 2, a: 1 }, 0, ['placeholder://source', 'placeholder://source']);
  assert.equal(first.revision, 1);
  assert.equal(first.status, 'unverified');
  assert.equal(first.verified, false);
  assert.equal(first.usableForPlanning, false);
  assert.equal(first.provenanceHash, createHash('sha256').update('{"actor":"test-suite","source":"unit-test"}').digest('hex'));
  assert.deepEqual(first.evidenceRefs, ['placeholder://source']);
  assert.equal(first.contentHash, createHash('sha256').update('{"content":{"a":1,"z":2},"evidenceRefs":["placeholder://source"]}').digest('hex'));
  assert.equal(first.provenanceHash, createHash('sha256').update('{"actor":"test-suite","source":"unit-test"}').digest('hex'));
  assert.equal(first.verified, false, 'placeholder evidence refs must never verify a node');
  assert.equal(first.usableForPlanning, false, 'placeholder evidence refs must never make a node planning-usable');
  assert.throws(() => store.saveNode({ goalId: 'goal-a', stableKey: 'bad', type: 'idea', content: {}, provenance, verified: true }), /unsupported fields/);
  assert.throws(() => create('goal-a', 'shared-plan', 'idea', { a: 3 }, 0), error => error.code === 'ERR_KNOWLEDGE_REVISION_CONFLICT');

  const second = store.saveNode({ goalId: 'goal-a', stableKey: 'shared-plan', type: 'idea', content: { a: 3 }, provenance, expectedRevision: 1 });
  assert.equal(second.revision, 2);
  assert.deepEqual(store.history(first.id).map(item => item.revision), [1, 2]);
  assert.deepEqual(store.history(first.id)[0].evidenceRefs, ['placeholder://source'], 'revision history preserves immutable evidence refs');
  assert.deepEqual(store.getNode(first.id, { revision: 1 }).evidenceRefs, ['placeholder://source']);
  assert.deepEqual(store.getNode(first.id, { revision: 1 }).content, { a: 1, z: 2 });
  assert.throws(() => db.prepare('UPDATE adaptive_goal_knowledge_revisions SET content_json=? WHERE node_id=?').run('{}', first.id), /append-only/);
  assert.throws(() => store.saveNode({ goalId: 'goal-a', stableKey: 'bad-verified', type: 'idea', content: {}, provenance: { source: 'x', actor: 'y' }, status: 'verified' }), /unsupported fields/);

  const evidence = create('goal-a', 'evidence-1', 'evidence', { ref: 'placeholder://not-verified' }, 0, ['placeholder://not-verified', 'placeholder://result']);
  const capability = create('goal-a', 'recovery-target', 'capability', { name: 'fallback' });
  assert.throws(() => store.addEdge({ goalId: 'goal-a', fromId: evidence.id, toId: capability.id, type: 'recovers_to', provenance }), /requires condition and outcome/);
  const attempt = create('goal-a', 'primary-attempt', 'experiment', { label: 'Primary experiment' });
  const recovery = store.addEdge({
    goalId: 'goal-a', fromId: attempt.id, toId: capability.id, type: 'recovers_to', provenance,
    condition: { when: 'verification_failed', predicate: 'verification_failed_with_evidence' },
    outcome: { state: 'fallback_ready', effects: ['record-fallback'], evidenceRefs: ['placeholder://result'] },
    evidenceRefs: ['placeholder://not-verified']
  });
  assert.equal(recovery.type, 'recovers_to');
  const replayedRecovery = store.addEdge({
    goalId: 'goal-a', fromId: attempt.id, toId: capability.id, type: 'recovers_to', provenance,
    condition: { when: 'verification_failed', predicate: 'verification_failed_with_evidence' },
    outcome: { state: 'fallback_ready', effects: ['record-fallback'], evidenceRefs: ['placeholder://result'] },
    evidenceRefs: ['placeholder://not-verified']
  });
  assert.equal(replayedRecovery.edgeId, recovery.edgeId);
  assert.equal(replayedRecovery.reused, true);
  assert.deepEqual(replayedRecovery.provenance, recovery.provenance);
  assert.throws(() => store.addEdge({
    goalId: 'goal-a', fromId: attempt.id, toId: capability.id, type: 'recovers_to',
    provenance: { source: 'different-source', actor: 'test-suite' },
    condition: { when: 'verification_failed', predicate: 'verification_failed_with_evidence' },
    outcome: { state: 'fallback_ready', effects: ['record-fallback'], evidenceRefs: ['placeholder://result'] },
    evidenceRefs: ['placeholder://not-verified']
  }), /immutable edge identity already exists/);
  const defaultSearch = store.search({ goalId: 'goal-a' });
  assert.equal(defaultSearch.nodes.length, 4);
  assert.equal(defaultSearch.nodes.every(node => node.status === 'unverified' && node.verified === false && node.usableForPlanning === false), true);
  assert.deepEqual(defaultSearch.nodes.find(node => node.stableKey === 'evidence-1').evidenceRefs, ['placeholder://not-verified', 'placeholder://result']);
  assert.equal(defaultSearch.nodes.find(node => node.stableKey === 'evidence-1').provenanceHash, createHash('sha256').update('{"actor":"test-suite","source":"unit-test"}').digest('hex'));
  assert.deepEqual(defaultSearch.planning.usableNodeIds, []);
  assert.equal(defaultSearch.edges.length, 0);
  assert.equal(store.search({ goalId: 'goal-a', includeUnverified: false }).nodes.length, 0);
  assert.equal(store.search({ goalId: 'goal-a', includeUnverified: true, includeRecoveryEdges: true }).edges.length, 1);

  const reused = create('goal-b', 'shared-plan', 'idea', { a: 3 });
  assert.equal(reused.id, second.id);
  assert.deepEqual(reused.memberships, ['goal-a', 'goal-b']);
  assert.equal(store.history(reused.id).length, 2, 'cross-goal membership must share revision history');
  const reuseSearch = store.search({ goalId: 'goal-b', includeUnverified: true });
  assert.equal(reuseSearch.reusedNodes.length, 1);
  assert.equal(reuseSearch.reusedNodes[0].stableKey, 'shared-plan');
  const globalSearch = store.search({ includeUnverified: true });
  assert.equal(globalSearch.nodes.length, new Set(globalSearch.nodes.map(node => node.id)).size,
    'global search must return one current row per shared stable identity, not duplicate it once per goal membership');
  assert.equal(globalSearch.reusedNodes.length, 1, 'reuse must count unique shared nodes, not duplicated membership join rows');
  assert.equal(reused.status, 'unverified');
  assert.equal(store.search({ goalId: 'goal-b' }).nodes.find(node => node.stableKey === 'shared-plan').id,
    store.search({ goalId: 'goal-a' }).nodes.find(node => node.stableKey === 'shared-plan').id);

  const injection = "x' OR 1=1 --";
  assert.equal(store.search({ goalId: injection, includeUnverified: true }).nodes.length, 0);
  assert.throws(() => store.saveNode({ goalId: 'goal-a', stableKey: 'sql', type: 'idea', content: { x: 1 }, provenance: { source: 'x', actor: 'y', extra: 'no' } }), /unsupported fields/);
  assert.throws(() => store.saveNode({ goalId: 'goal-a', stableKey: 'missing-provenance', type: 'idea', content: {} }), /provenance/);
  console.log('adaptive goal knowledge store tests passed');
} finally {
  db.close();
}
