#!/usr/bin/env python3
"""Validate exact WS6 diagnostic source strings and WS2 domain layering."""
from __future__ import annotations
import json, re
from collections import Counter
from pathlib import Path
FIXTURE=Path(__file__).with_name("02-control-domain-error-diagnostics-v2.1.fixtures.json")
CODE_RE=re.compile(r"^[A-Z][A-Z0-9_]*$")
APPROVAL_DECISION_ONLY={
 "AGG_APPROVAL_BINDING_UNAVAILABLE","AGG_APPROVAL_CLOCK_INVALID","AGG_APPROVAL_DECISION_BINDING_MISMATCH",
 "AGG_APPROVAL_DECISION_INVALID","AGG_APPROVAL_EVIDENCE_SCHEMA_UNSUPPORTED","AGG_APPROVAL_EVIDENCE_SHAPE_INVALID",
 "AGG_APPROVAL_MAKER_BINDING_MISMATCH","AGG_APPROVAL_MAKER_CHECKER_VIOLATION","AGG_APPROVAL_NONCE_DUPLICATE",
 "AGG_APPROVAL_NONCE_REPLAY","AGG_APPROVAL_POLICY_NOT_OBSERVED","AGG_APPROVAL_POLICY_REVIEWER_DUPLICATE",
 "AGG_APPROVAL_POLICY_ROLLBACK","AGG_APPROVAL_POLICY_ROOT_UNTRUSTED","AGG_APPROVAL_POLICY_RULES_INVALID",
 "AGG_APPROVAL_POLICY_VERSION_GAP","AGG_APPROVAL_POLICY_VERSION_REUSED","AGG_APPROVAL_QUORUM_NOT_MET",
 "AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE","AGG_APPROVAL_REVIEWER_DUPLICATE",
 "AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID","AGG_APPROVAL_SIGNATURE_INVALID","AGG_APPROVAL_VETO_REJECTED",
 "AGG_TRUST_CONFIG_NOT_CONFIGURED"
}
EXPECTED={
 "GOVERNANCE_RECEIPT_REQUEST_INVALID","GOVERNANCE_RECEIPT_CLOCK_INVALID","GOVERNANCE_RECEIPT_BINDING_INVALID",
 "GOVERNANCE_RECEIPT_IDENTITY_UNAUTHORIZED","GOVERNANCE_RECEIPT_TIME_INVALID","GOVERNANCE_RECEIPT_SIGNER_KEY_MISMATCH",
 "GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED","GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID",
 "GOVERNANCE_RECEIPT_TRUST_SNAPSHOT_MISMATCH","GOVERNANCE_RECEIPT_PAYLOAD_MISMATCH","GOVERNANCE_RECEIPT_DIGEST_MISMATCH",
 "GOVERNANCE_RECEIPT_SIGNATURE_BINDING_MISMATCH","GOVERNANCE_RECEIPT_SIGNATURE_DIGEST_MISMATCH",
 "GOVERNANCE_RECEIPT_NONCE_LEDGER_UNAVAILABLE","GOVERNANCE_RECEIPT_NONCE_CONFLICT","GOVERNANCE_RECEIPT_SIGNATURE_INVALID",
 "AGG_APPROVAL_SIGNATURE_INVALID","AGG_TRUST_CONFIG_NOT_OBSERVED","AGG_TRUST_CONFIG_ROLLBACK",
 "AGG_TRUST_ROOT_OUTSIDE_VALIDITY","AGG_TRUST_ROOT_REVOKED","AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID",
 "AGG_APPROVAL_EVIDENCE_NONCE_INVALID","AGG_APPROVAL_CLOCK_INVALID","AGG_APPROVAL_SIGNATURE_ENVELOPE_EXPIRED",
 "AGG_APPROVAL_SIGNATURE_ENVELOPE_FUTURE_DATED","AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE",
 "AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID","AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE"
}

def main() -> int:
 d=json.loads(FIXTURE.read_text(encoding='utf-8'))
 rows=d['cases']; codes=[r['cause_code'] for r in rows]
 assert len(codes)==len(set(codes)), 'cause_code inventory must be unique; multiple source sites belong in one sources array'
 assert all(r.get('sources') and len(r['sources'])==len(set(r['sources'])) for r in rows)
 assert set(codes)==EXPECTED, f'exact source inventory differs: missing={sorted(EXPECTED-set(codes))} extra={sorted(set(codes)-EXPECTED)}'
 assert all(CODE_RE.fullmatch(c) for c in codes)
 assert all(r['mapping_status']=='DRAFT_PROPOSED' for r in rows)
 print(f'PASS exact case-sensitive WS6 source inventory: {len(EXPECTED)} unique codes; no shortened aliases')
 assert all(r['automatic_retry'] is False for r in rows)
 assert all(r['domain_code'] in {'AUTHENTICATION_FAILED','AUTHORIZATION_DENIED','MALFORMED_REQUEST','UNSUPPORTED_SCHEMA_VERSION','SUBJECT_MISMATCH','STALE_OWNER','IDEMPOTENCY_CONFLICT','STALE_WORKFLOW_HEAD','ORDERING_GAP','AUTHORITY_UNAVAILABLE','EVIDENCE_UNRESOLVED'} for r in rows)
 print('PASS WS2 domain_code remains distinct from exact cause_code; mappings remain DRAFT')
 auth_unavailable=[r for r in rows if r['domain_code']=='AUTHORITY_UNAVAILABLE']
 assert auth_unavailable and all(r['resolution'] in {'UNKNOWN','UNRESOLVED'} for r in auth_unavailable)
 assert all(r['cause_code']!='AUTHORITY_UNAVAILABLE' for r in rows)
 nonce=next(r for r in rows if r['cause_code']=='GOVERNANCE_RECEIPT_NONCE_CONFLICT')
 assert nonce['domain_code']=='IDEMPOTENCY_CONFLICT' and nonce['resolution']=='CONFLICT'
 print('PASS authority errors retain precise cause and unresolved state; nonce rebinding is non-retryable conflict')
 rejected=d['valid_rejected_receipt']
 assert rejected['decision']=='Rejected' and rejected['domain_code'] is None and rejected['cause_code'] is None
 assert rejected['admission_authorized'] is False and rejected['transport_error'] is False
 print('PASS verified Rejected receipt remains domain decision, not auth/transport error')
 assert d['ws6_source']['governance_receipt_rs_sha256']=='d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09'
 assert d['ws6_source']['signed_envelope_rs_sha256']=='1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f'
 assert d['ws6_source']['trust_error_code_source_sha256']=='5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f'
 assert d['ws6_source']['approval_decision_rs_sha256']=='c2a91acff103f58ac5746db520588c3308a0394437ebb75256dc1b4351969fc3'
 sources={r['cause_code']:set(r['sources']) for r in rows}
 assert 'signed_envelope.rs' in sources['AGG_APPROVAL_SIGNATURE_INVALID']
 assert 'approval_decision.rs' in sources['AGG_APPROVAL_SIGNATURE_INVALID']
 assert 'approval_decision.rs' in sources['AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID']
 assert 'approval_decision.rs' in sources['AGG_APPROVAL_CLOCK_INVALID']
 inventory=d['approval_decision_source_inventory']
 assert inventory['status']=='SOURCE_INVENTORY_ONLY_NOT_MAPPED_TO_WS2_DOMAIN_CODE'
 assert len(inventory['codes'])==len(set(inventory['codes']))
 assert set(inventory['codes'])==APPROVAL_DECISION_ONLY, f"ApprovalDecision source inventory mismatch: missing={sorted(APPROVAL_DECISION_ONLY-set(inventory['codes']))} extra={sorted(set(inventory['codes'])-APPROVAL_DECISION_ONLY)}"
 assert inventory['source_sha256']==d['ws6_source']['approval_decision_rs_sha256']
 print('PASS fixture pins exact WS6 source revision hashes and all overlapping-source attribution')
 print(f"PASS separate ApprovalDecision source inventory: {len(APPROVAL_DECISION_ONLY)} exact unique codes; deliberately unmapped")
 print('LIMIT: explicit source-string inventory/fixture structure only; no verifier/runtime/API or route behavior; domain group mappings still DRAFT')
 return 0
if __name__=='__main__': raise SystemExit(main())
