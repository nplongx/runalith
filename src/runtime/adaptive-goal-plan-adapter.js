import { createHash } from 'node:crypto';
import { classifyAdaptiveGoalEvidenceReference, searchAdaptiveGoalGraph, validateAdaptiveGoalGraph } from './adaptive-goal-graph.js';
import { isAuthenticatedAdaptiveGoalKnowledgeVerificationReport } from './adaptive-goal-knowledge-verifier.js';

export const ADAPTIVE_GOAL_PLAN_DRAFT_SCHEMA_VERSION = 1;

const ACTION_NODE_TYPES = new Set(['task', 'experiment']);
// Object identity alone is not enough to authenticate a mutable draft. Bind
// the exact digest and upstream attestation identity at creation time, then
// freeze the whole authenticated tree before exposing it to downstream code.
const authenticatedPlanDrafts = new WeakMap();

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

export function isAuthenticatedAdaptiveGoalPlanDraft(value) {
  if (!isRecord(value)) return false;
  const authenticated = authenticatedPlanDrafts.get(value);
  if (!authenticated || !Object.isFrozen(value) || value.source?.verification?.verified !== true ||
      value.source.verification.status !== 'verified' ||
      value.source.verification.snapshotHash !== authenticated.snapshotHash ||
      value.source.verification.attestationId !== authenticated.attestationId ||
      value.source.verification.evidenceManifestHash !== authenticated.evidenceManifestHash ||
      value.draftHash !== authenticated.draftHash) return false;
  const { draftHash, ...unsigned } = value;
  const expiresAt = Date.parse(value.source.verification.expiresAt || '');
  return hash(stableJson(unsigned)) === authenticated.draftHash &&
    Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Public projection inputs cross a trust boundary. Validate property
// descriptors before normal property access so accessors cannot run code
// while a graph or candidate is being inspected. Authenticated verifier
// reports use a separate in-process capability and are not serialized here.
function assertStrictJsonInput(value, label, { seen = new Set(), depth = 0 } = {}) {
  if (depth > 64) reject(`${label} exceeds maximum JSON nesting depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) reject(`${label} must be acyclic JSON data without repeated object identities`);
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || keys.some(key => typeof key !== 'string' ||
        (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) ||
        keys.length !== value.length + 1) reject(`${label} arrays must be dense standard arrays without extra or symbol properties`);
    seen.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) reject(`${label} arrays must not be sparse`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject(`${label} arrays must contain enumerable data properties only`);
      assertStrictJsonInput(descriptor.value, label, { seen, depth: depth + 1 });
    }
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) reject(`${label} must contain plain JSON records only`);
  if (keys.some(key => typeof key !== 'string' || key === '__proto__')) reject(`${label} contains a forbidden key`);
  seen.add(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject(`${label} objects must contain enumerable data properties only`);
    assertStrictJsonInput(descriptor.value, label, { seen, depth: depth + 1 });
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function authenticatedSnapshotNodeLabel(node) {
  const content = node?.content && typeof node.content === 'object' && !Array.isArray(node.content) ? node.content : {};
  return [content.label, content.title, content.name, content.summary]
    .find(value => typeof value === 'string' && value.trim()) || node?.stable_key;
}

/**
 * Check the semantic fields actually projected from a verified persisted
 * snapshot. A signed snapshot must not be used to authenticate caller-edited
 * task labels or evidence references merely because node IDs and types match.
 */
export function matchesAdaptiveGoalKnowledgeSnapshotProjection(graph, snapshot) {
  if (!isRecord(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) ||
      !isRecord(snapshot) || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) return false;
  const projectedNodes = graph.nodes.map(node => ({
    id: node.id, type: node.type, label: node.label || node.id, evidenceRefs: node.evidenceRefs
  })).sort((a, b) => a.id.localeCompare(b.id));
  const snapshotNodes = snapshot.nodes.map(node => ({
    id: node.id, type: node.type, label: authenticatedSnapshotNodeLabel(node), evidenceRefs: node.evidence_refs
  })).sort((a, b) => a.id.localeCompare(b.id));
  const projectedEdges = graph.edges.map(edge => ({ from: edge.from, to: edge.to, type: edge.type }))
    .sort((a, b) => `${a.from}:${a.to}:${a.type}`.localeCompare(`${b.from}:${b.to}:${b.type}`));
  const snapshotEdges = snapshot.edges.filter(edge => edge.type !== 'recovers_to')
    .map(edge => ({ from: edge.from_id, to: edge.to_id, type: edge.type }))
    .sort((a, b) => `${a.from}:${a.to}:${a.type}`.localeCompare(`${b.from}:${b.to}:${b.type}`));
  return stableJson(snapshotNodes) === stableJson(projectedNodes) &&
    stableJson(snapshotEdges) === stableJson(projectedEdges);
}

function reject(message) {
  throw new TypeError(`AdaptiveGoalPlanAdapter: ${message}`);
}

/**
 * Project an exact AGG search candidate into a review-only generic Plan Graph.
 * This creates data only: it never compiles or persists an immutable workflow
 * execution plan and never authorizes dispatch or task execution.
 */
export function projectAdaptiveGoalCandidateToPlanGraph(graphInput, candidateInput, optionsInput, projectionOptionsInput = {}, sourceVerificationInput = null) {
  assertStrictJsonInput(graphInput, 'graph');
  assertStrictJsonInput(candidateInput, 'candidate');
  if (optionsInput !== undefined) assertStrictJsonInput(optionsInput, 'search options');
  assertStrictJsonInput(projectionOptionsInput, 'projection options');
  if (!isRecord(projectionOptionsInput) || Object.keys(projectionOptionsInput).some(key => key !== 'dependencyMode') ||
      (projectionOptionsInput.dependencyMode !== undefined &&
        !['sequential_path', 'source_edges_only'].includes(projectionOptionsInput.dependencyMode))) {
    reject('projection options must contain only dependencyMode=sequential_path|source_edges_only');
  }
  const dependencyMode = projectionOptionsInput.dependencyMode || 'sequential_path';
  if (!isRecord(candidateInput)) reject('candidate must be an object returned by AGG search');
  const graph = validateAdaptiveGoalGraph(graphInput);
  const search = searchAdaptiveGoalGraph(graphInput, optionsInput);
  const candidate = search.candidates.find(item => item.planId === candidateInput.planId);
  if (!candidate || stableJson(candidate) !== stableJson(candidateInput)) {
    reject('candidate does not exactly match a complete candidate from this graph and search configuration');
  }
  if (candidate.status !== 'proposed' || candidate.verification?.status !== 'unverified' || candidate.verification?.verified !== false) {
    reject('only complete, explicitly unverified proposals can be projected');
  }
  if (candidate.pathNodeIds[0] !== graph.startNodeId || candidate.pathNodeIds.at(-1) !== graph.goalNodeId) {
    reject('candidate path must bind the graph start and goal');
  }
  let sourceVerification = { status: 'unverified', verified: false };
  if (sourceVerificationInput !== null) {
    if (!isAuthenticatedAdaptiveGoalKnowledgeVerificationReport(sourceVerificationInput) ||
        sourceVerificationInput.snapshotHash !== sourceVerificationInput.snapshot?.snapshot_hash ||
        !matchesAdaptiveGoalKnowledgeSnapshotProjection(graph, sourceVerificationInput.snapshot)) {
      reject('source verification must be an in-process report from the configured verifier for the exact current snapshot; caller-supplied flags or serialized reports are not proof');
    }
    sourceVerification = {
      status: 'verified', verified: true,
      providerId: sourceVerificationInput.providerId,
      attestationId: sourceVerificationInput.attestationId,
      trustRootSha256: sourceVerificationInput.trustRootSha256,
      snapshotHash: sourceVerificationInput.snapshotHash,
      evidenceManifestHash: sourceVerificationInput.evidenceManifestHash,
      issuedAt: sourceVerificationInput.issuedAt,
      expiresAt: sourceVerificationInput.expiresAt,
      claimVerified: true,
      independenceVerified: true,
      verifiedNodeCount: sourceVerificationInput.verifiedNodeCount,
      verifiedEdgeCount: sourceVerificationInput.verifiedEdgeCount,
      verifiedMembershipCount: sourceVerificationInput.verifiedMembershipCount
    };
  }

  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const pathIndexById = new Map(candidate.pathNodeIds.map((id, index) => [id, index]));
  const actionNodes = candidate.pathNodeIds
    .slice(1)
    .map(id => nodeById.get(id))
    .filter(node => ACTION_NODE_TYPES.has(node.type));
  if (!actionNodes.length) {
    reject('candidate path has no task or experiment nodes to project into a Plan Graph');
  }

  const taskIdByNodeId = new Map(actionNodes.map(node => [
    node.id,
    `agg-step-${hash(`${graph.graphHash}\n${candidate.planId}\n${node.id}`).slice(0, 24)}`
  ]));
  const initiallyAvailable = new Set(search.search.options.initiallyAvailableIds);
  const edgesByRequiredNode = new Map();
  for (const edge of graph.edges) {
    if (edge.type === 'requires_all') {
      const list = edgesByRequiredNode.get(edge.to) || [];
      list.push(edge.from);
      edgesByRequiredNode.set(edge.to, list);
    } else if (edge.type === 'depends_on') {
      const list = edgesByRequiredNode.get(edge.from) || [];
      list.push(edge.to);
      edgesByRequiredNode.set(edge.from, list);
    }
  }

  let previousStepId = null;
  const steps = actionNodes.map((node, actionIndex) => {
    const dependencyStepIds = new Set();
    if (dependencyMode === 'sequential_path' && previousStepId) dependencyStepIds.add(previousStepId);
    const requiredNodeIds = edgesByRequiredNode.get(node.id) || [];
    const pathPosition = pathIndexById.get(node.id);
    for (const requiredNodeId of requiredNodeIds.sort((a, b) =>
      (pathIndexById.get(a) ?? Number.MAX_SAFE_INTEGER) - (pathIndexById.get(b) ?? Number.MAX_SAFE_INTEGER) || (a < b ? -1 : a > b ? 1 : 0))) {
      const requiredPosition = pathIndexById.get(requiredNodeId);
      if (requiredPosition === undefined && !initiallyAvailable.has(requiredNodeId)) {
        reject(`candidate does not satisfy prerequisite ${requiredNodeId} for ${node.id}`);
      }
      if (requiredPosition !== undefined && requiredPosition >= pathPosition) {
        reject(`candidate places prerequisite ${requiredNodeId} after dependent node ${node.id}`);
      }
      const requiredStepId = taskIdByNodeId.get(requiredNodeId);
      if (requiredStepId) dependencyStepIds.add(requiredStepId);
    }
    const dependencies = actionNodes.slice(0, actionIndex)
      .map(priorNode => taskIdByNodeId.get(priorNode.id))
      .filter(priorStepId => dependencyStepIds.has(priorStepId));
    const stepId = taskIdByNodeId.get(node.id);
    previousStepId = stepId;
    return {
      id: stepId,
      sourceNodeId: node.id,
      kind: node.type,
      title: node.label || node.id,
      dependencies,
      estimates: {
        cost: node.estimatedCost,
        risk: node.estimatedRisk,
        successConfidence: node.estimatedSuccessConfidence,
        reusePotential: node.reusePotential,
        informationValue: node.informationValue,
        metricProvenance: structuredClone(node.metricProvenance)
      },
      supportingEvidenceRefs: [...node.evidenceRefs],
      evidenceAssessment: {
        status: node.evidenceRefs.length === 0 ? 'missing' :
          node.evidenceRefs.every(ref => classifyAdaptiveGoalEvidenceReference(ref) === 'placeholder_not_evidence')
            ? 'placeholder_only' : 'declared_unverified',
        references: node.evidenceRefs.map(reference => ({
          reference,
          classification: classifyAdaptiveGoalEvidenceReference(reference),
          verified: false
        })),
        verifiedReferenceCount: 0
      },
      execution: { enabled: false, authorization: 'none', executable: null, args: null },
      status: 'proposed'
    };
  });

  const actionNodeIds = new Set(actionNodes.map(node => node.id));
  const contextNodes = candidate.pathNodeIds
    .filter(id => id !== graph.startNodeId && id !== graph.goalNodeId && !actionNodeIds.has(id))
    .map(id => nodeById.get(id))
    .map(node => ({
      id: node.id,
      type: node.type,
      ...(node.label === undefined ? {} : { label: node.label }),
      supportingEvidenceRefs: [...node.evidenceRefs],
      evidenceAssessment: {
        status: node.evidenceRefs.length === 0 ? 'missing' :
          node.evidenceRefs.every(ref => classifyAdaptiveGoalEvidenceReference(ref) === 'placeholder_not_evidence')
            ? 'placeholder_only' : 'declared_unverified',
        references: node.evidenceRefs.map(reference => ({
          reference,
          classification: classifyAdaptiveGoalEvidenceReference(reference),
          verified: false
        })),
        verifiedReferenceCount: 0
      }
    }));
  const goalNode = nodeById.get(graph.goalNodeId);
  const draft = {
    schemaVersion: ADAPTIVE_GOAL_PLAN_DRAFT_SCHEMA_VERSION,
    kind: 'adaptive_goal_plan_graph_draft',
    status: 'review_required',
    source: {
      mode: 'shadow',
      graphHash: graph.graphHash,
      candidatePlanId: candidate.planId,
      candidateStatus: candidate.status,
      verification: sourceVerification,
      searchStatus: search.status,
      searchExhaustive: search.search.exhaustive
    },
    goal: {
      nodeId: goalNode.id,
      ...(goalNode.label === undefined ? {} : { label: goalNode.label })
    },
    sourcePathNodeIds: [...candidate.pathNodeIds],
    contextNodes,
    steps,
    gates: {
      humanReviewRequired: true,
      workflowApprovalRequired: true,
      immutableExecutionPlanCreated: false,
      dispatchAllowed: false,
      executionAuthorized: false
    }
  };
  draft.draftHash = hash(stableJson(draft));
  if (sourceVerification.verified === true) {
    deepFreeze(draft);
    authenticatedPlanDrafts.set(draft, Object.freeze({
      draftHash: draft.draftHash,
      snapshotHash: sourceVerification.snapshotHash,
      attestationId: sourceVerification.attestationId,
      evidenceManifestHash: sourceVerification.evidenceManifestHash
    }));
  }
  return draft;
}
