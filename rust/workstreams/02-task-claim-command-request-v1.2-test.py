#!/usr/bin/env python3
"""Validate exact two-vector consumer source plus separate WS2 supplement provenance."""
from __future__ import annotations
import copy,hashlib,json
from pathlib import Path
HERE=Path(__file__).resolve().parent
FIXTURE=HERE/'02-task-claim-command-request-v1.2.fixtures.json'
KEYS=('executable','arguments','working_directory','environment','stdin')
class Reject(ValueError): pass

def require(ok:bool,msg:str)->None:
 if not ok: raise Reject(msg)
def sha(raw:bytes)->str: return hashlib.sha256(raw).hexdigest()
def snapshot(filename:str,expected:str)->dict:
 raw=(HERE/filename).read_bytes()
 require(sha(raw)==expected,filename+' snapshot SHA-256 mismatch')
 return json.loads(raw)
def command_bytes(command:dict)->bytes:
 require(isinstance(command,dict),'command object')
 require(set(command)==set(KEYS),'CommandRequestV1 closed field set')
 require(isinstance(command['executable'],str) and command['executable'].startswith('/'),'absolute executable path')
 require(isinstance(command['arguments'],list) and all(isinstance(x,str) for x in command['arguments']),'string arguments')
 require(isinstance(command['working_directory'],str),'working directory string')
 require(isinstance(command['environment'],dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in command['environment'].items()),'environment string map')
 require(isinstance(command['stdin'],list) and all(isinstance(x,int) and not isinstance(x,bool) and 0<=x<=255 for x in command['stdin']),'stdin byte vector')
 ordered={'executable':command['executable'],'arguments':command['arguments'],'working_directory':command['working_directory'],'environment':{k:command['environment'][k] for k in sorted(command['environment'])},'stdin':command['stdin']}
 return json.dumps(ordered,ensure_ascii=False,separators=(',',':')).encode('utf-8')
def verify(v:dict)->bytes:
 raw=command_bytes(v['command'])
 require(raw.decode('utf-8')==v['serialized_json'],v['name']+': serialized JSON mismatch')
 require(sha(raw)==v['command_sha256'],v['name']+': command digest mismatch')
 return raw

def main()->int:
 d=json.loads(FIXTURE.read_text(encoding='utf-8'))
 assert d['status']=='DRAFT_NOT_RATIFIED'
 c=snapshot(d['ws2_snapshot_copies']['consumer_vectors'],d['consumer_vector_source_sha256'])
 s=snapshot(d['ws2_snapshot_copies']['consumer_supplement'],d['consumer_vector_supplement_sha256'])
 p=snapshot(d['ws2_snapshot_copies']['producer_fixture'],d['producer_fixture_snapshot_sha256'])
 assert c['profile']=='runalith-current-command-request-serde-v1' and c['status']=='DRAFT_NOT_RATIFIED'
 assert len(c['vectors'])==d['consumer_vector_source_vector_count']==2
 assert s['status']=='DRAFT_NOT_RATIFIED' and s['byte_length']==176
 assert s['source_message_id']==d['consumer_vector_supplement_source_message_id']
 assert p['status']=='DRAFT_NOT_RATIFIED' and len(p['positive_vectors'])==2
 vectors=d['positive_vectors']; assert len(vectors)==3
 for i,src in enumerate(c['vectors']):
  v=vectors[i]
  assert v['name']==src['name'] and v['command']==src['command']
  assert v['serialized_json']==src['serialized_json'] and v['command_sha256']==src['sha256']
  raw=verify(v)
  assert p['positive_vectors'][i]['command']==src['command']
  print(f"PASS consumer source vector {v['name']} bytes={len(raw)} sha256={sha(raw)}")
 extra=vectors[2]
 assert extra['name']=='ws2-current-producer-command-vector'
 assert extra['command']==s['command'] and extra['serialized_json']==s['serialized_json']
 assert extra['command_sha256']==s['command_sha256']
 raw=verify(extra)
 assert len(raw)==s['byte_length']==176
 assert sha(raw)==extra['command_sha256']=='d663cd8fd7c063804596f5403532efe767ed302d01ec4f153d9c287df409c730'
 print(f"PASS separate WS2 producer supplement bytes={len(raw)} sha256={sha(raw)}")
 print('PASS provenance: two-vector WS3 file + distinct WS2 supplement + WS3 producer-fixture snapshot')
 base=vectors[0]; mutations=[]
 x=copy.deepcopy(base['command']); x.pop('executable'); mutations.append(('missing_executable',x))
 x=copy.deepcopy(base['command']); x['shell']=True; mutations.append(('unknown_field',x))
 x=copy.deepcopy(base['command']); x['stdin']=[-1,256]; mutations.append(('stdin_not_byte_array',x))
 x=copy.deepcopy(base['command']); x['environment']['TOKEN']=7; mutations.append(('environment_not_string_map',x))
 x=copy.deepcopy(base['command']); x['arguments']=['--changed']; mutations.append(('changed_command_bytes_same_digest',x))
 x=copy.deepcopy(base['command']); x['working_directory']='different'; mutations.append(('changed_digest_same_command',x))
 for name,cmd in mutations:
  try:
   raw=command_bytes(cmd); require(sha(raw)==base['command_sha256'],'digest mismatch')
  except (Reject,TypeError,KeyError): print('PASS negative '+name)
  else: raise AssertionError('negative accepted: '+name)
 print('RESULT PASS: 3 exact vectors (2 WS3 + 1 WS2 supplement) + 6 negative mutations')
 print('LIMIT: current CommandRequest serde/content hash only; not TaskClaim signed preimage, command policy, trust authority or execution')
 return 0
if __name__=='__main__': raise SystemExit(main())
