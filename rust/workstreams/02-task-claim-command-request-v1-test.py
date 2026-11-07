#!/usr/bin/env python3
"""Validate DRAFT TaskClaimV4 -> current CommandRequestV1 logical mapping."""
from __future__ import annotations
import copy, hashlib, json
from pathlib import Path
FIXTURE=Path(__file__).with_name("02-task-claim-command-request-v1.fixtures.json")
KEYS=("executable","arguments","working_directory","environment","stdin")

class Reject(ValueError): pass

def require(ok: bool, message: str) -> None:
    if not ok: raise Reject(message)

def command_bytes(command: dict) -> bytes:
    require(isinstance(command,dict),"command must be object")
    require(set(command)==set(KEYS),"CommandRequestV1 closed field set mismatch")
    require(isinstance(command["executable"],str) and command["executable"].startswith("/"),"executable must be absolute path string")
    require(isinstance(command["arguments"],list) and all(isinstance(x,str) for x in command["arguments"]),"arguments must be string array")
    require(isinstance(command["working_directory"],str),"working_directory must be string")
    require(isinstance(command["environment"],dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in command["environment"].items()),"environment must be string map")
    require(isinstance(command["stdin"],list) and all(isinstance(x,int) and not isinstance(x,bool) and 0<=x<=255 for x in command["stdin"]),"stdin must be byte array")
    ordered={"executable":command["executable"],"arguments":command["arguments"],"working_directory":command["working_directory"],"environment":{k:command["environment"][k] for k in sorted(command["environment"])},"stdin":command["stdin"]}
    return json.dumps(ordered,ensure_ascii=False,separators=(",",":" )).encode("utf-8")

def check_vector(v:dict) -> None:
    raw=command_bytes(v["command"])
    require(raw.decode("utf-8")==v["serialized_json"],f"{v['name']}: serialized bytes mismatch")
    require(hashlib.sha256(raw).hexdigest()==v["command_sha256"],f"{v['name']}: command_sha256 mismatch")

def main()->int:
    d=json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert d["status"]=="DRAFT_NOT_RATIFIED"
    assert len(d["positive_vectors"])==2
    for v in d["positive_vectors"]:
        check_vector(v)
        print(f"PASS command vector {v['name']} SHA-256 {v['command_sha256']}")
    # Negative mutations exercise strict field/type mapping and digest coupling.
    source=d["positive_vectors"][0]
    mutations=[]
    x=copy.deepcopy(source["command"]); x.pop("executable"); mutations.append(("missing_executable",x))
    x=copy.deepcopy(source["command"]); x["shell"]=True; mutations.append(("unknown_field",x))
    x=copy.deepcopy(source["command"]); x["stdin"]=[-1,256]; mutations.append(("stdin_not_byte_array",x))
    x=copy.deepcopy(source["command"]); x["environment"]["TOKEN"]=7; mutations.append(("environment_not_string_map",x))
    x=copy.deepcopy(source["command"]); x["arguments"]=["--changed"]; mutations.append(("changed_command_bytes_same_digest",x))
    x=copy.deepcopy(source["command"]); x["working_directory"]="different"; mutations.append(("changed_digest_same_command",x))
    for name,cmd in mutations:
        try:
            raw=command_bytes(cmd)
            require(hashlib.sha256(raw).hexdigest()==source["command_sha256"],"digest mismatch")
        except (Reject,TypeError,KeyError):
            print(f"PASS negative {name}")
        else:
            raise AssertionError(f"negative case unexpectedly accepted: {name}")
    require(d["consumer_vector_source_sha256"]=="55fc6229bc5cb7c3c16b18bc8e67371bf3849bb18a196d30d88ba281e20e17bd","consumer source vector pin changed")
    print("RESULT PASS: 2 producer/consumer byte vectors + 6 negative mutations")
    print("LIMIT: current CommandRequestV1 serialization only; not a ratified TaskClaimV4 mapping, command policy, signed claim preimage, authority or execution test")
    return 0
if __name__=="__main__": raise SystemExit(main())
