#!/usr/bin/env python3
import json,re,hashlib
from pathlib import Path
B=Path(__file__).parent
S=json.loads((B/'02-control-domain-diagnostic-v1.schema.json').read_text())
F=json.loads((B/'02-control-domain-diagnostic-v1.fixtures.json').read_text())
assert F['status']=='DRAFT_NOT_RATIFIED'
assert hashlib.sha256((B/'02-control-domain-diagnostic-v1.schema.json').read_bytes()).hexdigest()==F['schema_sha256']
assert S['$id']==F['schema_id'] and S['additionalProperties'] is False
assert S['required']==['domain_code','cause_code']
allowed=set(F['domain_code_enum'])
assert set(S['properties']['domain_code']['oneOf'][0]['enum'])==allowed
assert F['source_diagnostics_fixture_sha256']=='24e5d115604dfc066d25b056d27e9ef5cc7f4653477aced469d1ab8188e91832'
source=json.loads((B/'02-control-domain-error-diagnostics-v2.3.1.fixtures.json').read_text())
expected={r['cause_code']:r['domain_code'] for r in source['cases']}
assert len(expected)==29 and len(F['positive_payloads'])==29
for p in F['positive_payloads']:
 assert set(p)=={'domain_code','cause_code'}
 assert p['cause_code'] in expected and expected[p['cause_code']]==p['domain_code']
 assert p['domain_code'] is None or p['domain_code'] in allowed
 assert re.fullmatch(r'[A-Z][A-Z0-9_]{0,127}',p['cause_code'])
print('PASS typed route payload projection: 29/29 exact source cause/domain pairs')
# Minimal structural JSON Schema checks for this closed object profile.
def validate(p):
 if not isinstance(p,dict): return 'REJECT_TYPE'
 if set(p)-{'domain_code','cause_code'}: return 'REJECT_UNKNOWN_FIELD'
 if 'domain_code' not in p or 'cause_code' not in p: return 'REJECT_REQUIRED'
 d,c=p['domain_code'],p['cause_code']
 if d is not None and not isinstance(d,str): return 'REJECT_TYPE'
 if d is not None and d not in allowed: return 'REJECT_ENUM'
 if not isinstance(c,str): return 'REJECT_TYPE'
 if not re.fullmatch(r'[A-Z][A-Z0-9_]{0,127}',c): return 'REJECT_PATTERN'
 return 'ACCEPT'
for n in F['negative_cases']:
 assert validate(n['payload'])==n['expected'], (n['id'],validate(n['payload']),n['expected'])
 print('PASS negative',n['id'])
assert validate({'domain_code':None,'cause_code':'GOVERNANCE_RECEIPT_SIGNATURE_ENVELOPE_INVALID'})=='ACCEPT'
print('PASS null domain_code remains representable without success inference')
print('LIMIT: schema/fixture structure only; no runtime route, envelope mapping, HTTP/retry, cryptographic or authority proof')
