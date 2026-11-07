import { getAgentContract } from './agent-contracts.js';
import { normalizeGovernanceRole } from '../agent-session-policy.js';
export { SessionPermission, assertSessionGrantAuthority, assertSessionRevokeAuthority } from '../agent-session-policy.js';

export function hasAgentPermission(role, permission) {
  const canonical = normalizeGovernanceRole(role);
  if (canonical === 'system') return true;
  return getAgentContract(canonical).permissions.includes(permission);
}

export function assertAgentPermission(role, permission) {
  if (!hasAgentPermission(role, permission)) {
    throw new Error(`Agent permission denied: role=${role} permission=${permission}`);
  }
  return true;
}

export { normalizeGovernanceRole };

