#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { validateAdaptiveGoalGraph } from '../src/runtime/adaptive-goal-graph.js';
import { createAdaptiveGoalDiscriminatorExample } from '../src/runtime/adaptive-goal-phase2-search.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let outputPath;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--help') {
    console.log('Usage: node scripts/create-agg-phase3-adversarial-corpus.mjs --output NEW_CORPUS.json\n\nCreates a deterministic 24-case synthetic adversarial corpus for technical regression only. It is not operational evidence, independent adjudication, or an owner-signed corpus. Outputs are exclusive and existing files are never overwritten.');
    process.exit(0);
  }
  if (argument !== '--output') throw new Error(`Unknown argument: ${argument}`);
  if (outputPath) throw new Error('Duplicate --output argument');
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value for --output');
  outputPath = path.resolve(args[++index]);
}
if (!outputPath) throw new Error('--output is required');
const outputParent = path.dirname(outputPath);
const parent = fs.lstatSync(outputParent, { throwIfNoEntry: false });
if (!parent?.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(outputPath)) {
  throw new Error('Output must be a new file in an existing canonical non-symlink directory');
}
const id = (name, suffix) => `${name}-${String(suffix).padStart(2, '0')}`;
const node = (name, suffix, type, metrics = {}) => ({ id: id(name, suffix), type, ...metrics });
const edge = (from, to, type = 'next_step') => ({ from, to, type });
const cases = [];
for (let index = 1; index <= 24; index++) {
  const start = id('start', index), goal = id('goal', index), idea = id('idea', index);
  const test = id('test', index), prerequisite = id('prerequisite', index), decoy = id('dead-end', index);
  const rival = id('rival', index);
  const noSolution = index % 6 === 0;
  const usePrerequisite = !noSolution && index % 2 === 0;
  const useTwoStep = !noSolution && index % 3 === 0;
  const nodes = [
    { id: start, type: 'task', label: `Start task ${index}`, estimatedCost: 0.1 },
    { id: goal, type: 'goal', label: `Goal ${index}` },
    { id: decoy, type: 'idea', label: `Attractive dead-end ${index}`,
      estimatedCost: 0.05, estimatedRisk: 0.7, estimatedSuccessConfidence: 0.2,
      reusePotential: 0.1, informationValue: 0.95 },
    { id: idea, type: 'idea', label: `Validated route ${index}`,
      estimatedCost: Number((0.4 + (index % 5) * 0.1).toFixed(2)),
      estimatedRisk: Number((0.05 + (index % 4) * 0.04).toFixed(2)),
      estimatedSuccessConfidence: Number((0.65 + (index % 4) * 0.07).toFixed(2)),
      reusePotential: Number((0.1 + (index % 6) * 0.12).toFixed(2)),
      informationValue: Number((0.2 + (index % 5) * 0.15).toFixed(2)) },
    { id: test, type: 'experiment', label: `Check route ${index}`,
      estimatedCost: Number((0.2 + (index % 3) * 0.15).toFixed(2)),
      estimatedRisk: Number((0.02 + (index % 3) * 0.03).toFixed(2)),
      estimatedSuccessConfidence: Number((0.7 + (index % 3) * 0.08).toFixed(2)),
      reusePotential: Number((0.15 + (index % 4) * 0.15).toFixed(2)),
      informationValue: Number((0.2 + (index % 4) * 0.17).toFixed(2)) }
  ];
  const edges = [
    edge(start, decoy),
    edge(idea, test, 'next_step'),
    edge(test, goal, 'next_step'),
    edge(idea, test, 'tested_by'),
    edge(test, goal, 'supports'),
    edge(decoy, idea, 'contradicts')
  ];
  let successfulPath;
  if (noSolution) {
    // Deliberately no nominal transition reaches the goal; a bounded independent
    // verifier must prove this before the benchmark accepts the empty oracle list.
    edges.splice(edges.findIndex(item => item.from === test && item.to === goal && item.type === 'next_step'), 1);
    successfulPath = [];
  } else if (usePrerequisite) {
    nodes.push({ id: prerequisite, type: 'condition', label: `Required precondition ${index}`,
      estimatedCost: 0.05, estimatedRisk: 0.01, estimatedSuccessConfidence: 0.95,
      reusePotential: 0.2, informationValue: 0.3 });
    edges.push(edge(start, prerequisite), edge(prerequisite, idea), edge(prerequisite, idea, 'requires_all'));
    successfulPath = [start, prerequisite, idea, test, goal];
  } else if (useTwoStep) {
    const analysis = id('analysis', index);
    nodes.push({ id: analysis, type: 'hypothesis', label: `Intermediate hypothesis ${index}`,
      estimatedCost: 0.12, estimatedRisk: 0.04, estimatedSuccessConfidence: 0.82,
      reusePotential: 0.4, informationValue: 0.6 });
    edges.push(edge(start, analysis), edge(analysis, idea), edge(analysis, idea, 'supports'));
    successfulPath = [start, analysis, idea, test, goal];
  } else {
    edges.push(edge(start, idea));
    successfulPath = [start, idea, test, goal];
  }
  if (index % 4 === 0 && !noSolution) {
    nodes.push({ id: rival, type: 'idea', label: `Conflicting alternative ${index}`,
      estimatedCost: 0.03, estimatedRisk: 0.6, estimatedSuccessConfidence: 0.45,
      reusePotential: 0.1, informationValue: 0.2 });
    // This branch is structurally reachable but cannot then join the oracle
    // route: the graph declares its alternative idea contradictory to `idea`.
    edges.push(edge(start, rival), edge(rival, idea), edge(rival, idea, 'alternative_to'));
  }
  // Keep a nominal dead-end branch, but no edge from it to the goal.
  const graph = { schemaVersion: 1, startNodeId: start, goalNodeId: goal, nodes, edges };
  const validated = validateAdaptiveGoalGraph(graph);
  if (successfulPath.length) {
    createAdaptiveGoalDiscriminatorExample({ graph, pathNodeIds: successfulPath, id: `fixture-oracle-${index}`, label: 1 });
  }
  cases.push({
    caseId: `phase3-adversarial-${String(index).padStart(2, '0')}`,
    graph,
    oracle: {
      successfulPathNodeIds: successfulPath.length ? [successfulPath] : [],
      outcomeRef: `synthetic-oracle:phase3-adversarial-${String(index).padStart(2, '0')}`
    },
    _graphHash: validated.graphHash
  });
}
const graphHashes = cases.map(item => item._graphHash);
if (new Set(graphHashes).size !== cases.length) throw new Error('Synthetic corpus generator produced duplicate graph identities');
const corpus = {
  schemaVersion: 1,
  corpusId: 'agg-phase3-adversarial-synthetic-v1',
  provenance: {
    kind: 'synthetic',
    source: 'deterministic adversarial fixture generated by scripts/create-agg-phase3-adversarial-corpus.mjs; no external adjudication',
    adjudicatorId: 'fixture-generator-not-an-adjudicator',
    protocol: 'phase3-synthetic-graph-enumeration-v1',
    independent: false
  },
  cases: cases.map(({ _graphHash, ...item }) => item)
};
parseStrictJson(`${JSON.stringify(corpus)}\n`, 'generated Phase 3 corpus');
writeFileExclusiveAtomic(outputPath, `${JSON.stringify(corpus, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, corpusId: corpus.corpusId, cases: corpus.cases.length,
  uniqueGraphCount: graphHashes.length, goalPathCases: corpus.cases.filter(item => item.oracle.successfulPathNodeIds.length).length,
  expectedNoSolutionCases: corpus.cases.filter(item => item.oracle.successfulPathNodeIds.length === 0).length,
  provenance: corpus.provenance, acceptance: 'synthetic_fixture_not_acceptance' }, null, 2));
