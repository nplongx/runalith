import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AdaptiveGoalTransactionBoundary } from '../src/runtime/adaptive-goal-transaction-boundary.js';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE tx_probe(id TEXT PRIMARY KEY)');
const boundary = new AdaptiveGoalTransactionBoundary({ db });

boundary.beginPlanGraphProposalCreate();
db.prepare('INSERT INTO tx_probe(id) VALUES(?)').run('plan-rollback');
boundary.rollbackPlanGraphProposalCreate();
assert.equal(db.prepare('SELECT 1 FROM tx_probe WHERE id=?').get('plan-rollback'), undefined);

boundary.beginPlanGraphProposalCreate();
db.prepare('INSERT INTO tx_probe(id) VALUES(?)').run('plan-commit');
boundary.commitPlanGraphProposalCreate();
assert.ok(db.prepare('SELECT 1 FROM tx_probe WHERE id=?').get('plan-commit'));

boundary.beginExecutionGraphProposalCreate();
db.prepare('INSERT INTO tx_probe(id) VALUES(?)').run('execution-graph-rollback');
boundary.rollbackExecutionGraphProposalCreate();
assert.equal(db.prepare('SELECT 1 FROM tx_probe WHERE id=?').get('execution-graph-rollback'), undefined);

boundary.beginExecutionGraphProposalRead();
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get().n, 1);
boundary.commitExecutionGraphProposalRead();

boundary.beginExecutionPlanCandidateCreate();
db.prepare('INSERT INTO tx_probe(id) VALUES(?)').run('candidate-rollback');
boundary.rollbackExecutionPlanCandidateCreate();
assert.equal(db.prepare('SELECT 1 FROM tx_probe WHERE id=?').get('candidate-rollback'), undefined);

boundary.beginExecutionPlanCandidateRead();
assert.ok(db.prepare('SELECT 1 FROM tx_probe WHERE id=?').get('plan-commit'));
boundary.commitExecutionPlanCandidateRead();

boundary.beginExecutionReadinessPreview();
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get().n, 1);
boundary.commitExecutionReadinessPreview();

boundary.beginSandboxActionClaim();
db.prepare('INSERT INTO tx_probe(id) VALUES(?)').run('sandbox-claim');
boundary.rollbackSandboxActionClaim();
assert.equal(db.prepare('SELECT 1 FROM tx_probe WHERE id=?').get('sandbox-claim'), undefined,
  'a failed one-shot sandbox claim transaction must leave no claim event');

db.close();
console.log('adaptive-goal transaction boundary contract PASS');
