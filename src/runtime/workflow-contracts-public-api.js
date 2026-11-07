// Host-side public facade for the standalone @runalith/workflow-contracts
// package. Keep runtime consumers on this root export rather than importing
// package internals directly. Host-owned adapters still decide which durable
// task/artifact read models are eligible before calling these pure contracts.
export {
  ArtifactType,
  ArtifactStatus,
  hashArtifactContent,
  createArtifactRecord,
  validateArtifact,
  validateArtifactContent,
  artifactSchemaForType
} from './workflow/artifacts.js';

export {
  normalizeSuccessContract,
  validateSuccessContract,
  hasEnforcedSuccessCriteria,
  evaluateSuccessPredicate,
  validateSuccessAssessment,
  successContractPrompt
} from './workflow/success-contract.js';

export { MAX_STRICT_JSON_BYTES, parseStrictJson } from './strict-json.js';
