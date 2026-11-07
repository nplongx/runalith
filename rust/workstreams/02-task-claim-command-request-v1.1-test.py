#!/usr/bin/env python3
"""Validate all current WS3 CommandRequest serde vectors and WS2 producer vector."""
from __future__ import annotations
import copy,hashlib,json
from pathlib import Path
FIXTURE=Path(__file__).with_name('02-task-claim-command-request-v1.1.fixtures.json')
KEYS=('executable','arguments','working_directory','environment','stdin')
class Reject(ValueError): pass

def require(ok:bool,msg:str)->None:
 if not ok: raise Reject(msg)
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
 require(raw.decode('utf-8')==v['serialized_json'],f"{v['name']}: bytes")
 require(hashlib.sha256(raw).hexdigest()==v['command_sha256'],f"{v['name']}: digest")
 return raw

def main()->int:
 d=json.loads(FIXTURE.read_text(encoding='utf-8'))
 assert d['status']=='DRAFT_NOT_RATIFIED'
 assert d['consumer_vector_source_sha256']=='2c6a8fdf9743786389fe2d1bfc93e4fdb957067c105cb20d1a6c780055e52532'
 vectors=d['positive_vectors']; assert len(vectors)==3
 for v in vectors:
  raw=verify(v); print(f"PASS {v['name']} bytes={len(raw)} sha256={hashlib.sha256(raw).hexdigest()}")
 assert vectors[2]['command']['executable']=='/usr/bin/printf'
 assert vectors[2]['execution']=='NOT_RUN_FIXTURE_ONLY'
 base=vectors[0]; mutations=[]
 x=copy.deepcopy(base['command']); x.pop('executable'); mutations.append(('missing_executable',x))
 x=copy.deepcopy(base['command']); x['shell']=True; mutations.append(('unknown_field',x))
 x=copy.deepcopy(base['command']); x['stdin']=[-1,256]; mutations.append(('stdin_not_byte_array',x))
 x=copy.deepcopy(base['command']); x['environment']['TOKEN']=7; mutations.append(('environment_not_string_map',x))
 x=copy.deepcopy(base['command']); x['arguments']=['--changed']; mutations.append(('changed_command_bytes_same_digest',x))
 x=copy.deepcopy(base['command']); x['working_directory']='different'; mutations.append(('changed_digest_same_command',x))
 for name,cmd in mutations:
  try:
   raw=command_bytes(cmd); require(hashlib.sha256(raw).hexdigest()==base['command_sha256'],'digest mismatch')
  except (Reject,TypeError,KeyError): print('PASS negative '+name)
  else: raise AssertionError('negative accepted: '+name)
 print('RESULT PASS: 3 exact Rust consumer serde vectors + 6 negative mutations')
 print('LIMIT: current CommandRequest struct serde bytes/content hash only; not TaskClaim signed preimage, policy, trust authority or execution')
 return 0
if __name__=='__main__': raise SystemExit(main())
