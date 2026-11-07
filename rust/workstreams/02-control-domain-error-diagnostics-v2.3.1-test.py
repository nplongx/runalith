#!/usr/bin/env python3
"""Validate WS2 diagnostic V2.2 source origin/propagation and mapping partitions."""
from __future__ import annotations
import json,re
from pathlib import Path
FIXTURE=Path(__file__).with_name('02-control-domain-error-diagnostics-v2.3.1.fixtures.json')
CODE=re.compile(r'^[A-Z][A-Z0-9_]*$')
EXPECTED_MAPPED={
 'GOVERNANCE_RECEIPT_REQUEST_INVALID','GOVERNANCE_RECEIPT_CLOCK_INVALID','GOVERNANCE_RECEIPT_BINDING_INVALID',
 'GOVERNANCE_RECEIPT_IDENTITY_UNAUTHORIZED','GOVERNANCE_RECEIPT_TIME_INVALID','GOVERNANCE_RECEIPT_SIGNER_KEY_MISMATCH',
 'GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED','GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID',
 'GOVERNANCE_RECEIPT_TRUST_SNAPSHOT_MISMATCH','GOVERNANCE_RECEIPT_PAYLOAD_MISMATCH','GOVERNANCE_RECEIPT_DIGEST_MISMATCH',
 'GOVERNANCE_RECEIPT_SIGNATURE_BINDING_MISMATCH','GOVERNANCE_RECEIPT_SIGNATURE_DIGEST_MISMATCH',
 'GOVERNANCE_RECEIPT_NONCE_LEDGER_UNAVAILABLE','GOVERNANCE_RECEIPT_NONCE_CONFLICT','GOVERNANCE_RECEIPT_SIGNATURE_INVALID',
 'AGG_APPROVAL_SIGNATURE_INVALID','AGG_TRUST_CONFIG_NOT_OBSERVED','AGG_TRUST_CONFIG_ROLLBACK',
 'AGG_TRUST_ROOT_OUTSIDE_VALIDITY','AGG_TRUST_ROOT_REVOKED','AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID',
 'AGG_APPROVAL_EVIDENCE_NONCE_INVALID','AGG_APPROVAL_CLOCK_INVALID','AGG_APPROVAL_SIGNATURE_ENVELOPE_EXPIRED',
 'AGG_APPROVAL_SIGNATURE_ENVELOPE_FUTURE_DATED','AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE',
 'AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID','AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE'
}
APPROVAL_DECISION_24={
 'AGG_APPROVAL_BINDING_UNAVAILABLE','AGG_APPROVAL_CLOCK_INVALID','AGG_APPROVAL_DECISION_BINDING_MISMATCH',
 'AGG_APPROVAL_DECISION_INVALID','AGG_APPROVAL_EVIDENCE_SCHEMA_UNSUPPORTED','AGG_APPROVAL_EVIDENCE_SHAPE_INVALID',
 'AGG_APPROVAL_MAKER_BINDING_MISMATCH','AGG_APPROVAL_MAKER_CHECKER_VIOLATION','AGG_APPROVAL_NONCE_DUPLICATE',
 'AGG_APPROVAL_NONCE_REPLAY','AGG_APPROVAL_POLICY_NOT_OBSERVED','AGG_APPROVAL_POLICY_REVIEWER_DUPLICATE',
 'AGG_APPROVAL_POLICY_ROLLBACK','AGG_APPROVAL_POLICY_ROOT_UNTRUSTED','AGG_APPROVAL_POLICY_RULES_INVALID',
 'AGG_APPROVAL_POLICY_VERSION_GAP','AGG_APPROVAL_POLICY_VERSION_REUSED','AGG_APPROVAL_QUORUM_NOT_MET',
 'AGG_APPROVAL_REPLAY_LEDGER_UNVERIFIABLE','AGG_APPROVAL_REVIEWER_DUPLICATE',
 'AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID','AGG_APPROVAL_SIGNATURE_INVALID','AGG_APPROVAL_VETO_REJECTED',
 'AGG_TRUST_CONFIG_NOT_CONFIGURED'
}
APPROVAL_POLICY_9={
 'AGG_TRUST_CONFIG_NOT_CONFIGURED','AGG_APPROVAL_POLICY_RULES_INVALID','AGG_APPROVAL_POLICY_REVIEWER_DUPLICATE',
 'AGG_APPROVAL_POLICY_ROOT_DUPLICATE','AGG_APPROVAL_POLICY_REVIEWER_ROOT_UNTRUSTED',
 'AGG_APPROVAL_POLICY_QUORUM_UNREACHABLE','AGG_APPROVAL_POLICY_ROLE_QUORUM_UNREACHABLE',
 'AGG_APPROVAL_POLICY_EXPIRED','AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID'
}

def main()->int:
 d=json.loads(FIXTURE.read_text(encoding='utf-8'))
 assert d['status']=='DRAFT_NOT_RATIFIED'
 rows=d['cases']; codes=[r['cause_code'] for r in rows]
 assert len(codes)==len(set(codes)) and set(codes)==EXPECTED_MAPPED
 print(f'PASS exact mapped cause-code inventory: {len(codes)} unique case-sensitive strings')
 assert all(CODE.fullmatch(c) for c in codes)
 for r in rows:
  assert r['origin_sources'] and len(r['origin_sources'])==len(set(r['origin_sources']))
  assert all(site['path'] in r['origin_sources'] for site in r['origin_sites']), r['cause_code']
  assert all(site['path'] in r['propagated_through'] for site in r['propagated_sites']), r['cause_code']
  assert all(site['role'] and site['lines'] for site in r['origin_sites']+r['propagated_sites']), r['cause_code']
  assert r['mapping_status'] in {'DRAFT_PROPOSED','REVIEW_REQUIRED'}
  if r['mapping_status']=='REVIEW_REQUIRED':
   assert r['domain_code'] is None and r['resolution']=='REVIEW_REQUIRED'
   assert r['previous_draft_domain_code'] is not None
  else:
   assert r['domain_code'] is not None
  if r['cause_code'] in {'GOVERNANCE_RECEIPT_CLOCK_INVALID','AGG_APPROVAL_CLOCK_INVALID'}:
   assert r['operation_phases'] and any('host_clock' in x for x in r['operation_phases'])
  if r['cause_code']=='GOVERNANCE_RECEIPT_TIME_INVALID':
   assert r['operation_phases']==['signed_receipt_timestamp_parse']
 print('PASS origin_sources / propagated_through / test_assertion_sites are separate; no origin/propagation conflation')
 mapped=set(codes)
 ad=d['approval_decision_source_inventory']
 ad_ex=set(ad['emitted_codes_exclusive_to_mapped_inventory'])
 ad_overlap=set(ad['emitted_codes_also_in_mapped_inventory'])
 ad_test=set(ad['test_assertion_only_overlap_with_mapped_inventory'])
 assert len(ad_ex)==21 and len(ad_overlap)==2 and len(ad_test)==1
 assert ad_ex|ad_overlap|ad_test==APPROVAL_DECISION_24
 assert ad_ex.isdisjoint(ad_overlap|ad_test) and ad_overlap.isdisjoint(ad_test)
 assert ad_overlap=={'AGG_APPROVAL_CLOCK_INVALID','AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID'}
 assert ad_test=={'AGG_APPROVAL_SIGNATURE_INVALID'}
 assert ad_overlap==(APPROVAL_DECISION_24 & mapped)-ad_test
 assert ad_test==(APPROVAL_DECISION_24 & mapped)-ad_overlap
 print('PASS ApprovalDecision partition: 21 exclusive emitted + 2 overlapping emitted + 1 test-assertion-only')
 policy=d['approval_policy_source_inventory']
 assert set(policy['emitted_codes'])==APPROVAL_POLICY_9
 assert set(policy['mapped_inventory_overlap'])=={'AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID'}
 assert set(policy['approval_decision_overlap'])=={'AGG_TRUST_CONFIG_NOT_CONFIGURED','AGG_APPROVAL_POLICY_RULES_INVALID','AGG_APPROVAL_POLICY_REVIEWER_DUPLICATE','AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID'}
 assert set(policy['approval_policy_decision_overlap'])==set(policy['approval_decision_overlap'])
 print('PASS ApprovalPolicy exact 9-code origin inventory and overlaps')
 trust=d['trust_source_origin_inventory']
 assert set(trust['trust_ledger']['origin_codes'])=={'AGG_TRUST_CONFIG_NOT_OBSERVED','AGG_TRUST_CONFIG_ROLLBACK'}
 assert set(trust['trust_config']['origin_codes'])=={'AGG_TRUST_ROOT_OUTSIDE_VALIDITY','AGG_TRUST_ROOT_REVOKED'}
 assert set(trust['trust_error_code']['mapping_codes'])=={'AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE','AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID','AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE'}
 origin={r['cause_code']:set(r['origin_sources']) for r in rows}
 expected_origins={
  **{code:{'governance_receipt.rs'} for code in EXPECTED_MAPPED if code.startswith('GOVERNANCE_RECEIPT_')},
  'AGG_APPROVAL_SIGNATURE_INVALID':{'signed_envelope.rs'},
  'AGG_TRUST_CONFIG_NOT_OBSERVED':{'trust_ledger.rs'},
  'AGG_TRUST_CONFIG_ROLLBACK':{'trust_ledger.rs'},
  'AGG_TRUST_ROOT_OUTSIDE_VALIDITY':{'trust_config.rs'},
  'AGG_TRUST_ROOT_REVOKED':{'trust_config.rs'},
  'AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID':{'approval_policy.rs','approval_decision.rs','signed_envelope.rs'},
  'AGG_APPROVAL_EVIDENCE_NONCE_INVALID':{'signed_envelope.rs'},
  'AGG_APPROVAL_CLOCK_INVALID':{'approval_decision.rs','signed_envelope.rs'},
  'AGG_APPROVAL_SIGNATURE_ENVELOPE_EXPIRED':{'signed_envelope.rs'},
  'AGG_APPROVAL_SIGNATURE_ENVELOPE_FUTURE_DATED':{'signed_envelope.rs'},
  'AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE':{'lib.rs::TrustError::code()'},
  'AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID':{'lib.rs::TrustError::code()','trust_config.rs'},
  'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE':{'lib.rs::TrustError::code()','trust_ledger.rs'}
 }
 assert origin==expected_origins, f'origin attribution mismatch: {[(k,origin[k],expected_origins.get(k)) for k in origin if origin[k]!=expected_origins.get(k)]}'
 expected_propagation={
  'AGG_TRUST_CONFIG_NOT_OBSERVED':{'approval_decision.rs','approval_policy.rs','governance_receipt.rs','signed_envelope.rs'},
  'AGG_TRUST_CONFIG_ROLLBACK':{'approval_decision.rs','approval_policy.rs','governance_receipt.rs','signed_envelope.rs'},
  'AGG_TRUST_ROOT_OUTSIDE_VALIDITY':{'approval_decision.rs','approval_policy.rs','governance_receipt.rs','signed_envelope.rs'},
  'AGG_TRUST_ROOT_REVOKED':{'approval_decision.rs','approval_policy.rs','governance_receipt.rs','signed_envelope.rs'},
  'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE':{'approval_decision.rs','approval_policy.rs','governance_receipt.rs','signed_envelope.rs'},
  'AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE':{'trust_config.rs'},
  'AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID':{'trust_config.rs'}
 }
 for code,sites in expected_propagation.items():
  assert set(rows[codes.index(code)]['propagated_through'])==sites, (code,rows[codes.index(code)]['propagated_through'],sites)
 assert origin['AGG_APPROVAL_SIGNATURE_INVALID']=={'signed_envelope.rs'}
 assert set(rows[codes.index('AGG_APPROVAL_SIGNATURE_INVALID')]['test_assertion_sites'])=={'governance_receipt.rs:1047','approval_decision.rs:1665'}
 assert origin['AGG_TRUST_CONFIG_NOT_OBSERVED']=={'trust_ledger.rs'}
 assert origin['AGG_TRUST_CONFIG_ROLLBACK']=={'trust_ledger.rs'}
 assert origin['AGG_TRUST_ROOT_REVOKED']=={'trust_config.rs'}
 assert origin['AGG_TRUST_ROOT_OUTSIDE_VALIDITY']=={'trust_config.rs'}
 assert set(rows[codes.index('AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID')]['propagated_through'])=={'trust_config.rs'}
 print('PASS source-origin corrections incl. trust_config + TrustError::code public-key mappings; line/function site roles pinned')
 print('PASS caller verify-input signature mapping separated from malformed envelope and host signer-output errors')
 review={r['cause_code'] for r in rows if r['mapping_status']=='REVIEW_REQUIRED'}
 expected_review={
  'GOVERNANCE_RECEIPT_CLOCK_INVALID','GOVERNANCE_RECEIPT_TIME_INVALID','GOVERNANCE_RECEIPT_SIGNER_KEY_MISMATCH',
  'GOVERNANCE_RECEIPT_SIGNATURE_INVALID','GOVERNANCE_RECEIPT_CANONICALIZATION_FAILED',
  'GOVERNANCE_RECEIPT_TRUST_SNAPSHOT_MISMATCH','GOVERNANCE_RECEIPT_PAYLOAD_MISMATCH',
  'GOVERNANCE_RECEIPT_DIGEST_MISMATCH','GOVERNANCE_RECEIPT_SIGNATURE_BINDING_MISMATCH',
  'GOVERNANCE_RECEIPT_SIGNATURE_DIGEST_MISMATCH','AGG_APPROVAL_CLOCK_INVALID',
  'AGG_APPROVAL_SIGNATURE_ENVELOPE_EXPIRED','AGG_APPROVAL_SIGNATURE_ENVELOPE_FUTURE_DATED',
  'AGG_TRUST_ROOT_OUTSIDE_VALIDITY','AGG_TRUST_ROOT_REVOKED','AGG_TRUST_CONFIG_OPENSSL_UNAVAILABLE',
  'AGG_TRUST_CONFIG_LEDGER_UNAVAILABLE','AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID','AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID',
  'GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID'
 }
 assert review==expected_review
 sig=next(r for r in rows if r['cause_code']=='AGG_APPROVAL_SIGNATURE_INVALID')
 assert sig['domain_code']=='AUTHENTICATION_FAILED'
 assert sig['operation_phases']==['verify_input_signed_envelope_signature']
 assert sig['phase_domain_code']=={'verify_input_signed_envelope_signature':'AUTHENTICATION_FAILED'}
 env=next(r for r in rows if r['cause_code']=='AGG_APPROVAL_SIGNATURE_ENVELOPE_INVALID')
 assert env['domain_code'] is None and env['mapping_status']=='REVIEW_REQUIRED'
 assert len(env['origin_sites'])==5
 receipt_env=next(r for r in rows if r['cause_code']=='GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID')
 assert receipt_env['domain_code'] is None and receipt_env['mapping_status']=='REVIEW_REQUIRED'
 assert receipt_env['origin_sites'][0]['lines']=='483-505'
 key=next(r for r in rows if r['cause_code']=='AGG_TRUST_CONFIG_PUBLIC_KEY_INVALID')
 assert key['origin_sources']==['lib.rs::TrustError::code()','trust_config.rs']
 assert {s['lines'] for s in key['origin_sites'] if s['path']=='trust_config.rs'}=={'218-222','368-371'}
 assert {s['lines'] for s in key['propagated_sites']}=={'224-224','362-362'}
 signer=next(r for r in rows if r['cause_code']=='GOVERNANCE_RECEIPT_SIGNATURE_INVALID')
 assert signer['operation_phases']==['host_signer_output_signature_verification']
 assert signer['origin_sites'][0]['lines']=='228-243'
 nonce=next(r for r in rows if r['cause_code']=='GOVERNANCE_RECEIPT_NONCE_CONFLICT')
 assert nonce['domain_code']=='IDEMPOTENCY_CONFLICT' and nonce['automatic_retry'] is False
 assert d['valid_rejected_receipt']['decision']=='Rejected' and d['valid_rejected_receipt']['admission_authorized'] is False
 print('PASS ambiguous host/integrity/time groups remain unmapped pending review; nonce conflict and signed Rejected invariants retained')
 pins=d['ws6_source']
 expected_pins={
  'governance_receipt_rs_sha256':'d5f682af74da93dd4899a4cdd31d791382eb580a7f9eeaa3e392c9f0be8bbe09',
  'signed_envelope_rs_sha256':'1e7b638efa2577d1769254abe444ca18c77ea944df65d2cd526307b86f7c572f',
  'approval_decision_rs_sha256':'c2a91acff103f58ac5746db520588c3308a0394437ebb75256dc1b4351969fc3',
  'approval_policy_rs_sha256':'13235b7af591435904c5f2ea7c981932fc90e87c585a4023e0ee23b14a839775',
  'trust_ledger_rs_sha256':'ffc6847c31c91cdfd65b5a8763762f6215a29f814cea05cefd572bfd9e008418',
  'trust_config_rs_sha256':'a86b6d1b82882522149188a87373c25e5e36f81b704faea8f1057f761b367d02',
  'trust_error_code_source_sha256':'5fba5f3c618609c72e354e35488c92baf5b5c753754cda45f2c1e0484107be6f'
 }
 for key,value in expected_pins.items(): assert pins[key]==value, (key,pins[key],value)
 for inv in (ad,policy,trust['trust_ledger'],trust['trust_config'],trust['trust_error_code']):
  assert re.fullmatch(r'[0-9a-f]{64}',inv['source_sha256'] if 'source_sha256' in inv else inv['sha256'])
 print('PASS exact WS6 source hash pins across receipt, envelope, decision, policy, ledger, config and TrustError mappings')
 print('LIMIT: source attribution + structural fixture only; no verifier/runtime/API, cryptographic proof, Control transaction, route or ratification')
 return 0
if __name__=='__main__': raise SystemExit(main())
