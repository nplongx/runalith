import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasOnlySafeProposalArgumentKeys,
  validateSafeProposalArguments,
} from '../benchmarks/plugin-workflow-benchmark/dev-only-proposal-argument-guard.mjs';

const args = task => ({
  title: 'Proposal Persistence Test',
  task,
  workspace: '/case/workspace',
});

test('accepts equivalent explicit proposal-only, no-execution, no-file-write wording', () => {
  assert.doesNotThrow(() => validateSafeProposalArguments(args(
    'Confirm that this disposable local candidate can persist a proposal without executing any tasks, writing files, or making workspace modifications.',
  )));
  assert.doesNotThrow(() => validateSafeProposalArguments(args(
    'proposal-only; do not execute tasks; do not write files',
  )));
});

test('rejects tasks without explicit proposal-only intent or execution prohibition', () => {
  assert.throws(() => validateSafeProposalArguments(args('Run the workflow and report the result.')), /proposal-only work/);
  assert.throws(() => validateSafeProposalArguments(args('proposal-only and do not write files')), /prohibit execution/);
});

test('keeps argument allowlist, exact sandbox workspace and file-write prohibition fail-closed', () => {
  assert.throws(() => validateSafeProposalArguments({ ...args('proposal-only; do not execute; do not write files'), workflow: 'production' }), /unexpected proposal argument key/);
  assert.throws(() => validateSafeProposalArguments({ ...args('proposal-only; do not execute; do not write files'), workspace: '/tmp' }), /disposable workspace/);
  assert.throws(() => validateSafeProposalArguments(args('proposal-only; do not execute tasks')), /prohibit file writes/);
});

test('shares the allowlist with evidence serialization so failed model calls remain recordable', () => {
  assert.equal(hasOnlySafeProposalArgumentKeys(args('proposal-only; do not execute tasks; do not write files')), true);
  assert.equal(hasOnlySafeProposalArgumentKeys({ ...args('proposal-only; do not execute tasks; do not write files'), extra: true }), false);
  assert.equal(hasOnlySafeProposalArgumentKeys(null), false);
  assert.equal(hasOnlySafeProposalArgumentKeys([]), false);
});

test('rejects path traversal and absolute host paths even when denial phrases are present', () => {
  assert.throws(() => validateSafeProposalArguments(args('proposal-only; do not execute tasks; do not write files; inspect ../../etc/passwd')), /path traversal/);
  assert.throws(() => validateSafeProposalArguments(args('proposal-only; do not execute tasks; do not write files; inspect /etc/passwd')), /outside the disposable workspace/);
});

test('rejects conflicting affirmative mutation, execution, and privileged-tool instructions', () => {
  assert.throws(() => validateSafeProposalArguments(args('proposal-only; do not execute tasks; do not write files; but delete the workspace file')), /affirmative mutation intent/);
  assert.throws(() => validateSafeProposalArguments(args('proposal-only; do not execute tasks; do not write files; then dispatch the workflow')), /affirmative execution or authorization intent/);
  assert.throws(() => validateSafeProposalArguments(args('proposal-only; do not execute tasks; do not write files; request role_bindings')), /role bindings/);
});
