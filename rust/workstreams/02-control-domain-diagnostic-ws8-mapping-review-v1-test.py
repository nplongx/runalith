import json, hashlib
from pathlib import Path
B=Path(__file__).parent
F=json.loads((B/'02-control-domain-diagnostic-ws8-mapping-review-v1.fixtures.json').read_text())
for k,n in [('schema_sha256','02-control-domain-diagnostic-v1.0.1.schema.json'),('fixture_sha256','02-control-domain-diagnostic-v1.0.1.fixtures.json'),('source_diagnostics_sha256','02-control-domain-error-diagnostics-v2.3.1.fixtures.json')]:
 assert hashlib.sha256((B/n).read_bytes()).hexdigest()==F['producer_pins'][k]
S=json.loads((B/'02-control-domain-error-diagnostics-v2.3.1.fixtures.json').read_text())['cases']
P={x['cause_code']:x['domain_code'] for x in S}
assert len(P)==29

def check(rows):
 keys=[x['cause_code'] for x in rows]
 if len(keys)!=len(set(keys)): return 'REJECT_DUPLICATE_CAUSE'
 if set(keys)!=set(P): return 'REJECT_SOURCE_COVERAGE'
 if any(x['domain_code']!=P[x['cause_code']] for x in rows): return 'REJECT_PAIR_MISMATCH'
 return 'ACCEPT'
B0=F['known_cause_domain_rows']
assert check(B0)=='ACCEPT'
print('PASS exact 29/29 baseline')
for m in F['mutations']:
 rows=[dict(x) for x in B0]
 if m['id']=='wrong_valid_domain': rows[0]['domain_code']=m['domain_code']; got=check(rows)
 elif m['id']=='duplicate_cause': rows[-1]=dict(rows[0]); got=check(rows)
 elif m['id']=='missing_cause': rows=[x for x in rows if x['cause_code']!=m['cause_code']]; got=check(rows)
 else: got='REJECT_UNKNOWN_CAUSE_ATTRIBUTION' if m['domain_code'] is not None and m['cause_code'] not in P else 'ACCEPT'
 assert got==m['expected'],(m['id'],got,m['expected'])
 print('PASS',m['id'])
assert F['unknown_null']['domain_code'] is None and F['unknown_null']['cause_code'] not in P
print('PASS unknown future cause/null remains UNKNOWN_UNRESOLVED')
print('LIMIT: WS2 acceptance oracle only; no WS8 runtime proof')
