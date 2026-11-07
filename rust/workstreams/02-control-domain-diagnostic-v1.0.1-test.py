#!/usr/bin/env python3
import json,re,hashlib
from pathlib import Path
B=Path(__file__).parent
S_PATH=B/'02-control-domain-diagnostic-v1.0.1.schema.json'
F_PATH=B/'02-control-domain-diagnostic-v1.0.1.fixtures.json'
SOURCE_PATH=B/'02-control-domain-error-diagnostics-v2.3.1.fixtures.json'
S=json.loads(S_PATH.read_text())
F=json.loads(F_PATH.read_text())
source_bytes=SOURCE_PATH.read_bytes()
source_sha=hashlib.sha256(source_bytes).hexdigest()
assert F['status']=='DRAFT_NOT_RATIFIED'
assert source_sha==F['source_diagnostics_fixture_sha256'], (source_sha,F['source_diagnostics_fixture_sha256'])
assert hashlib.sha256(S_PATH.read_bytes()).hexdigest()==F['schema_sha256']
assert S['$id']==F['schema_id'] and S['additionalProperties'] is False
assert S['required']==['domain_code','cause_code']
allowed=set(F['domain_code_enum'])
assert set(S['properties']['domain_code']['oneOf'][0]['enum'])==allowed
source=json.loads(source_bytes)
expected={r['cause_code']:r['domain_code'] for r in source['cases']}
cause_codes=[p['cause_code'] for p in F['positive_payloads']]
assert len(expected)==29 and len(cause_codes)==29
assert len(set(cause_codes))==29, 'duplicate cause_code in positive projection'
assert set(cause_codes)==set(expected), 'positive projection does not cover exact source cause-code set'
for p in F['positive_payloads']:
 assert set(p)=={'domain_code','cause_code'}
 assert expected[p['cause_code']]==p['domain_code']
 assert p['domain_code'] is None or p['domain_code'] in allowed
 assert re.fullmatch(r'[A-Z][A-Z0-9_]{0,127}',p['cause_code'])
print('PASS actual source fixture SHA-256 and exact unique 29/29 cause-code coverage')
print('PASS typed route payload projection: 29/29 exact source cause/domain pairs')
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
for n in F['unknown_cause_code_cases']:
 p=n['payload']
 assert validate(p)=='ACCEPT' and p['domain_code'] is None
 assert p['cause_code']=='FUTURE_UNRECOGNIZED_CAUSE_V9' and p['cause_code'] not in expected
 print('PASS unknown future cause preserved verbatim; receiver disposition UNKNOWN/UNRESOLVED')
print('LIMIT: schema/fixture structural validation only; no runtime route, envelope mapping, HTTP/retry, cryptographic or authority proof')
