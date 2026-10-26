import assert from 'node:assert/strict';

export const SAFE_PROPOSAL_ARGUMENT_KEYS = Object.freeze(['title', 'task', 'workspace', 'goal']);
const allowedModelArgumentKeys = new Set(SAFE_PROPOSAL_ARGUMENT_KEYS);

export function hasOnlySafeProposalArgumentKeys(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args) &&
    Object.keys(args).every(key => allowedModelArgumentKeys.has(key));
}

export function validateSafeProposalArguments(args) {
  assert.ok(args && typeof args === 'object' && !Array.isArray(args), 'native tool arguments must be an object');
  assert.ok(hasOnlySafeProposalArgumentKeys(args), 'native tool arguments contain an unexpected proposal argument key');
  assert.equal(typeof args.title, 'string');
  assert.ok(args.title.trim().length > 0 && args.title.length <= 180, 'proposal title must be non-empty and bounded');
  assert.equal(typeof args.task, 'string');
  assert.ok(args.task.trim().length > 0 && args.task.length <= 12_000, 'proposal task must be non-empty and bounded');
  assert.equal(args.workspace, '/case/workspace', 'proposal must bind to the disposable workspace mount');
  assert.ok(/proposal[- ]only|only.{0,20}proposal|proposal.{0,100}without/i.test(args.task), 'task must explicitly limit itself to proposal-only work');
  assert.ok(/without execution|without executing|no execution|do not execute|must not execute/i.test(args.task), 'task must explicitly prohibit execution');
  assert.ok(/without file writes|without [^.!?]{0,100}\bwriting files\b|no file writes|do not write files|must not write files/i.test(args.task), 'task must explicitly prohibit file writes');
  assert.ok(!/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(args.task), 'proposal task must not contain path traversal');
  assert.ok(!/(?:^|[\s"'`=:(])\/(?:etc|root|home|tmp|var|opt|usr|plugin)(?:\/|$)/i.test(args.task),
    'proposal task must not reference paths outside the disposable workspace');
  const clauses = args.task.split(/[;.!?\n]+|\b(?:but|however|then|also|instead)\b/i).map(item => item.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (/\b(?:without|do not|don't|must not|never|no)\b/i.test(clause)) continue;
    assert.ok(!/\b(?:write|rewrite|modify|mutate|delete|remove|overwrite)\b(?:\s+\w+){0,6}\s+\b(?:file|files|workspace|configuration|config|database|artifact|production|command|script|shell|workflow|job|task|tasks)\b/i.test(clause),
      'proposal task contains affirmative mutation intent');
    assert.ok(!/\b(?:execute|run|dispatch|approve)\b(?:\s+\w+){0,5}\s+\b(?:command|script|shell|workflow|job|task|tasks|production)\b/i.test(clause),
      'proposal task contains affirmative execution or authorization intent');
  }
  assert.ok(!/required_operations|workspace_write_scopes|role_bindings|validation_profile/i.test(JSON.stringify(args)),
    'proposal must not request workspace mutation scopes, role bindings or validation profiles');
  assert.ok(!/workflow_approve|workflow_dispatch|workflow_e2e_run|workflow_prepare_tasks|task_execute_local|write_file/i.test(JSON.stringify(args)),
    'proposal must not request privileged execution or write tools');
}
