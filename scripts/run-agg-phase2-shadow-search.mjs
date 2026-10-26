#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../src/runtime/strict-json.js';
import { canonicalJson } from '../src/runtime/canonical-json.js';
import { readStableRegularFile, writeFileExclusiveAtomic } from '../src/runtime/exclusive-file.js';
import { validateAdaptiveGoalDiscriminatorModel } from '../src/runtime/adaptive-goal-discriminator.js';
import { validateAdaptiveGoalPhase2ModelArtifact } from '../src/runtime/adaptive-goal-phase2-dataset.js';
import { searchAdaptiveGoalGraphPhase2 } from '../src/runtime/adaptive-goal-phase2-search.js';
import { projectAdaptiveGoalPhase2CandidateToPlanGraphShadow } from '../src/runtime/adaptive-goal-phase2-plan-shadow.js';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceHash = relative => createHash('sha256').update(fs.readFileSync(path.join(repoRoot, relative))).digest('hex');
const args = process.argv.slice(2);
const seenArgs = new Set();
let graphPath;
let modelPath;
let outputPath;
let beamWidth = 4;
let maxDepth = 12;
let maxExpansions = 128;
let maxAuditEvents = 2000;

function usage() {
  console.log('Usage: node scripts/run-agg-phase2-shadow-search.mjs --graph GRAPH.json --model MODEL.json --output NEW_RESULT.json [--beam-width N] [--max-depth N] [--max-expansions N] [--max-audit-events N]\n\nThe graph is search-only data; --model is the artifact emitted by train-agg-phase2-discriminator.mjs. Output is created exclusively. This runner never executes a plan and does not change acceptance/readiness/gates.');
}

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--help') { usage(); process.exit(0); }
  if (!['--graph', '--model', '--output', '--beam-width', '--max-depth', '--max-expansions', '--max-audit-events'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  if (seenArgs.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
  seenArgs.add(arg);
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
  const value = args[++index];
  if (arg === '--graph') graphPath = path.resolve(value);
  else if (arg === '--model') modelPath = path.resolve(value);
  else if (arg === '--output') outputPath = path.resolve(value);
  else if (arg === '--beam-width') beamWidth = Number(value);
  else if (arg === '--max-depth') maxDepth = Number(value);
  else if (arg === '--max-expansions') maxExpansions = Number(value);
  else if (arg === '--max-audit-events') maxAuditEvents = Number(value);
}

if (!graphPath || !modelPath || !outputPath) {
  usage();
  process.exitCode = 2;
} else {
  const outputParent = path.dirname(outputPath);
  const outputParentStat = fs.lstatSync(outputParent);
  if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent || fs.existsSync(outputPath)) throw new Error('Output must be a new file in an existing canonical non-symlink directory');
  function readJsonFile(filePath, label) {
    const bytes = readStableRegularFile(filePath, { maxBytes: MAX_INPUT_BYTES, label });
    return { value: parseStrictJson(bytes, label, { maxBytes: MAX_INPUT_BYTES }), bytes };
  }
  const graphInput = readJsonFile(graphPath, 'Phase 2 shadow graph');
  const modelInput = readJsonFile(modelPath, 'Phase 2 discriminator model artifact');
  validateAdaptiveGoalPhase2ModelArtifact(modelInput.value);
  const expectedModelSources = {
    trainerCliSha256: sourceHash('scripts/train-agg-phase2-discriminator.mjs'),
    discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
    datasetValidatorSha256: sourceHash('src/runtime/adaptive-goal-phase2-dataset.js'),
    strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
    canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
  };
  if (canonicalJson(modelInput.value.sourceIdentity) !== canonicalJson(expectedModelSources)) throw new Error('Stale model source identity; retrain from the current source tree');
  const validatedModel = validateAdaptiveGoalDiscriminatorModel(modelInput.value.model);
  const result = searchAdaptiveGoalGraphPhase2(graphInput.value, validatedModel, { beamWidth, maxDepth, maxExpansions, maxAuditEvents });
  const planGraphDrafts = [], unprojectableCandidates = [];
  for (const candidate of result.candidates) {
    try {
      planGraphDrafts.push(projectAdaptiveGoalPhase2CandidateToPlanGraphShadow(graphInput.value, validatedModel, candidate, result.search.options));
    } catch (error) {
      unprojectableCandidates.push({ candidatePlanId: candidate.planId, code: 'PHASE2_PLAN_GRAPH_SHADOW_UNPROJECTABLE', reason: String(error?.message || error) });
    }
  }
  const artifact = {
    schemaVersion: 2,
    kind: 'agg_phase2_shadow_search_result',
    graphFileSha256: createHash('sha256').update(graphInput.bytes).digest('hex'),
    graphHash: result.graphHash,
    modelArtifactSha256: createHash('sha256').update(modelInput.bytes).digest('hex'),
    datasetId: modelInput.value.datasetId,
    datasetFileSha256: modelInput.value.datasetFileSha256,
    datasetSha256: modelInput.value.datasetSha256,
    featureSchemaVersion: modelInput.value.featureSchemaVersion,
    splitIdentities: modelInput.value.splitIdentities,
    runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
    sourceIdentity: {
      runnerCliSha256: sourceHash('scripts/run-agg-phase2-shadow-search.mjs'),
      phase2SearchSha256: sourceHash('src/runtime/adaptive-goal-phase2-search.js'),
      phase2PlanShadowAdapterSha256: sourceHash('src/runtime/adaptive-goal-phase2-plan-shadow.js'),
      phase1SearchSha256: sourceHash('src/runtime/adaptive-goal-graph.js'),
      discriminatorSha256: sourceHash('src/runtime/adaptive-goal-discriminator.js'),
      strictJsonParserSha256: sourceHash('src/runtime/strict-json.js'),
      canonicalJsonSha256: sourceHash('src/runtime/canonical-json.js')
    },
    result,
    planGraphShadow: {
      schemaVersion: 1, mode: 'shadow', drafts: planGraphDrafts, unprojectableCandidates,
      gates: { persisted: false, immutableExecutionPlanCreated: false, dispatchAllowed: false, executionAuthorized: false }
    }
  };
  writeFileExclusiveAtomic(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ outputPath, graphHash: result.graphHash, modelSha256: result.search.discriminatorModelSha256,
    datasetId: artifact.datasetId, status: result.status, candidateCount: result.candidates.length,
    acceptance: result.search.acceptance, executionAuthorized: result.search.executionAuthorized }, null, 2));
}
