#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createAdaptiveGoalKnowledgeStore } from '../src/runtime/adaptive-goal-knowledge-store.js';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const graph={
  schemaVersion:1,startNodeId:'start',goalNodeId:'goal',
  nodes:[
    {id:'start',type:'task',label:'Start task',evidenceRefs:['ref://runtime-test-evidence']},
    {id:'goal',type:'goal',label:'Observed goal',evidenceRefs:[]}
  ],
  edges:[{from:'start',to:'goal',type:'next_step'}]
};

test('real source MCP runtime persists AGG search lifecycle, observed steps, provenance, evidence and failures',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agg-planner-telemetry-runtime-'));
  fs.chmodSync(temp,0o700);
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  for(const dir of ['home','data','workspace','execution-tmp'])fs.mkdirSync(path.join(temp,dir),{recursive:true,mode:0o700});
  const dbPath=path.join(temp,'data','workflow.db');
  const child=spawn(process.execPath,[path.join(root,'server/index.js')],{
    cwd:root,stdio:['pipe','pipe','pipe'],
    env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:path.join(temp,'home'),NODE_ENV:'test',LANG:'C.UTF-8',
      RUNALITH_DATA_DIR:path.join(temp,'data'),RUNALITH_WORKFLOW_DB:dbPath,RUNALITH_WORKSPACE:path.join(temp,'workspace'),
      RUNALITH_EXECUTION_TMP_DIR:path.join(temp,'execution-tmp'),TMPDIR:temp,TEMP:temp,TMP:temp}
  });
  let stdoutBuffer='',stderr='',nextId=1,exited=false;
  const pending=new Map();
  const rejectPending=error=>{for(const [id,waiter] of pending){pending.delete(id);clearTimeout(waiter.timer);waiter.reject(error);}};
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP RPC timeout ${method}: ${stderr.slice(-1500)}`));},15000);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`,error=>{
      if(!error)return;const waiter=pending.get(id);if(!waiter)return;pending.delete(id);clearTimeout(waiter.timer);reject(error);
    });
  });
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    stdoutBuffer+=chunk;let newline;
    while((newline=stdoutBuffer.indexOf('\n'))>=0){
      const line=stdoutBuffer.slice(0,newline).trim();stdoutBuffer=stdoutBuffer.slice(newline+1);if(!line)continue;
      let message;try{message=JSON.parse(line);}catch{rejectPending(new Error(`non-JSON MCP stdout: ${line.slice(0,500)}`));child.kill('SIGKILL');return;}
      const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);clearTimeout(waiter.timer);waiter.resolve(message);}
    }
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1024*1024);});
  child.on('error',rejectPending);
  child.on('exit',(code,signal)=>{exited=true;rejectPending(new Error(`source MCP exited code=${code} signal=${signal}: ${stderr.slice(-2000)}`));});
  t.after(async()=>{
    if(!exited){child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{if(!exited)child.kill('SIGTERM');resolve();},1500);child.once('exit',()=>{clearTimeout(timer);resolve();});});}
    if(!exited)child.kill('SIGKILL');
  });

  const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'agg-planner-telemetry-integration',version:'1'}});
  assert.equal(initialized.error,undefined,JSON.stringify(initialized.error));
  child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})}\n`);
  const list=await rpc('tools/list');assert.ok(list.result.tools.some(tool=>tool.name==='adaptive_goal_graph_search'));
  const searchResponse=await rpc('tools/call',{name:'adaptive_goal_graph_search',arguments:{graph,options:{maxExpansions:8,maxDepth:4,maxAuditEvents:40}}});
  assert.equal(searchResponse.error,undefined,JSON.stringify(searchResponse.error));
  assert.notEqual(searchResponse.result?.isError,true,searchResponse.result?.content?.[0]?.text);
  const result=searchResponse.result?.structuredContent||JSON.parse(searchResponse.result?.content?.find(item=>item.type==='text')?.text||'null');
  assert.ok(result&&typeof result==='object','successful MCP result is parseable');
  const telemetry=result.telemetry;
  assert.equal(telemetry?.persisted,true,'successful tool result identifies its durable run row');
  assert.equal(telemetry?.persistence_scope,'planner_telemetry_only','persisted means audit telemetry, not candidate, Plan Graph, or Idea Graph persistence');
  assert.equal(telemetry?.terminal_record_persisted,true);
  assert.equal(telemetry?.status,'completed');assert.ok(telemetry.run_id);assert.ok(Number.isSafeInteger(telemetry.duration_ms)&&telemetry.duration_ms>=0);
  assert.ok(result.search&&result.auditTrace,'the actual algorithm result is returned alongside telemetry');

  let originalInputDigest;
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const row=db.prepare('SELECT * FROM adaptive_goal_planner_runs WHERE run_id=?').get(telemetry.run_id);
    assert.ok(row);assert.equal(row.tool_name,'adaptive_goal_graph_search');assert.equal(row.status,'completed');
    assert.equal(row.algorithm_status,result.status);assert.equal(row.duration_ms,telemetry.duration_ms);
    assert.match(row.request_sha256,/^[a-f0-9]{64}$/);assert.match(row.input_graph_sha256,/^[a-f0-9]{64}$/);
    originalInputDigest=row.input_graph_sha256;
    assert.equal(row.input_node_count,2);assert.equal(row.input_edge_count,1);assert.ok(row.observed_node_count>=2);assert.ok(row.observed_edge_count>=1);
    assert.equal(row.search_run_id,result.search?.searchRunId||result.auditTrace?.searchRunId||null);
    assert.equal(JSON.parse(row.provenance_json).search_outcome_is_not_acceptance,true);
    assert.equal(JSON.parse(row.provenance_json).knowledge_nodes_verified,false);
    const events=db.prepare('SELECT sequence,event_type,event_source,observed_at FROM adaptive_goal_planner_run_events WHERE run_id=? ORDER BY sequence').all(telemetry.run_id);
    assert.equal(events[0].event_type,'run_started');assert.equal(events[1].event_type,'search_input_observed');
    assert.ok(events.some(event=>event.event_source==='search_observer'),'algorithm emits real audit events into durable telemetry');
    assert.equal(events.at(-1).event_type,'run_completed');
    assert.ok(events.every((event,index)=>event.sequence===index+1));
    const nodes=db.prepare('SELECT node_id,source_kind,label FROM adaptive_goal_planner_run_nodes WHERE run_id=? ORDER BY node_id').all(telemetry.run_id);
    assert.deepEqual(nodes.map(item=>item.node_id),['goal','start']);
    assert.ok(nodes.every(item=>item.source_kind==='caller_graph'));
    assert.ok(db.prepare("SELECT 1 FROM adaptive_goal_planner_run_goals WHERE run_id=? AND goal_id='goal' AND goal_kind='graph_goal_node'").get(telemetry.run_id));
    assert.ok(db.prepare("SELECT 1 FROM adaptive_goal_planner_run_evidence WHERE run_id=? AND reference='ref://runtime-test-evidence' AND observation_source='declared_graph_reference'").get(telemetry.run_id));
    const counters=JSON.parse(row.metrics_json);
    assert.equal(Object.hasOwn(counters,'expansions'),typeof result.search?.expansions==='number');
    assert.equal(Object.hasOwn(counters,'estimated_success_confidence'),false,'missing confidence is not synthesized');
  }finally{db.close();}

  // Seed true append-only knowledge records after the first caller-only invocation, then
  // exercise the runtime's actual graph composer and persisted revision/edge linkage.
  let hypothesis,experiment,storedEdge;
  const knowledgeDb=new DatabaseSync(dbPath);
  try{
    const store=createAdaptiveGoalKnowledgeStore(knowledgeDb);
    hypothesis=store.saveNode({goalId:'runtime-knowledge-goal',stableKey:'telemetry-runtime-hypothesis',type:'hypothesis',content:{title:'Observed runtime hypothesis'},provenance:{source:'runtime-test-fixture',actor:'telemetry-integration',reference:'fixture://runtime-hypothesis'},evidenceRefs:['ref://runtime-composed-evidence']});
    experiment=store.saveNode({goalId:'runtime-knowledge-goal',stableKey:'telemetry-runtime-experiment',type:'experiment',content:{title:'Observed runtime experiment'},provenance:{source:'runtime-test-fixture',actor:'telemetry-integration'},evidenceRefs:[]});
    storedEdge=store.addEdge({goalId:'runtime-knowledge-goal',fromId:hypothesis.id,toId:experiment.id,type:'tested_by',provenance:{source:'runtime-test-fixture',actor:'telemetry-integration'},evidenceRefs:['ref://runtime-composed-evidence']});
  }finally{knowledgeDb.close();}
  const composedResponse=await rpc('tools/call',{name:'adaptive_goal_graph_search',arguments:{
    graph,knowledge_goal_id:'runtime-knowledge-goal',knowledge_node_ids:[hypothesis.id,experiment.id],
    knowledge_bindings:[{from_node_id:'start',to_node_id:hypothesis.id,edge_type:'supports'},{from_node_id:experiment.id,to_node_id:'goal',edge_type:'supports'}],
    options:{maxExpansions:12,maxDepth:6,maxAuditEvents:40}
  }});
  assert.notEqual(composedResponse.result?.isError,true,composedResponse.result?.content?.[0]?.text);
  const composedResult=composedResponse.result?.structuredContent||JSON.parse(composedResponse.result?.content?.find(item=>item.type==='text')?.text||'null');
  const composedRunId=composedResult.telemetry?.run_id;
  assert.ok(composedRunId);assert.equal(composedResult.telemetry.persisted,true);
  assert.equal(composedResult.telemetry.persistence_scope,'planner_telemetry_only');
  assert.equal(composedResult.telemetry.terminal_record_persisted,true);
  assert.equal(composedResult.knowledgeSnapshot?.goalId,'runtime-knowledge-goal');
  assert.equal(composedResult.knowledgeSnapshot?.snapshotHash?.length,64);
  const composedDb=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const run=composedDb.prepare('SELECT * FROM adaptive_goal_planner_runs WHERE run_id=?').get(composedRunId);
    assert.equal(run.status,'completed');assert.equal(run.input_node_count,2,'the caller digest remains distinct from the composed graph');
    assert.equal(run.input_graph_sha256,originalInputDigest,'composing persistent knowledge does not rewrite the original caller graph digest');
    assert.notEqual(run.graph_hash,composedResult.knowledgeSnapshot.snapshotHash,'algorithm graph hash and knowledge snapshot hash remain distinct provenance fields');
    assert.ok(run.observed_node_count>run.input_node_count,'composed graph size is observed separately from original input size');
    const nodeRow=composedDb.prepare('SELECT * FROM adaptive_goal_planner_run_nodes WHERE run_id=? AND node_id=?').get(composedRunId,hypothesis.id);
    assert.equal(nodeRow.source_kind,'persisted_knowledge');assert.equal(nodeRow.knowledge_goal_id,'runtime-knowledge-goal');
    assert.equal(nodeRow.revision,hypothesis.revision);assert.equal(nodeRow.content_hash,hypothesis.contentHash);assert.equal(nodeRow.provenance_hash,hypothesis.provenanceHash);
    const edgeRow=composedDb.prepare('SELECT * FROM adaptive_goal_planner_run_edges WHERE run_id=? AND edge_id=?').get(composedRunId,storedEdge.edgeId);
    assert.ok(edgeRow);assert.equal(edgeRow.source_kind,'persisted_knowledge');assert.equal(edgeRow.goal_id,'runtime-knowledge-goal');
    assert.ok(composedDb.prepare('SELECT 1 FROM adaptive_goal_planner_run_goals WHERE run_id=? AND goal_id=? AND goal_kind=\'knowledge_scope\'').get(composedRunId,'runtime-knowledge-goal'));
    assert.equal(JSON.parse(run.provenance_json).knowledge_snapshot_hash,composedResult.knowledgeSnapshot.snapshotHash);
    const obs=composedDb.prepare('SELECT * FROM adaptive_goal_planner_run_evidence WHERE run_id=? AND reference=? AND observation_source=\'declared_graph_reference\'').get(composedRunId,'ref://runtime-composed-evidence');
    assert.ok(obs);assert.equal(obs.claim_verified,null,'declared evidence reference is never promoted to a verified claim');
  }finally{composedDb.close();}

  const invalidGraph={...graph,edges:[...graph.edges,{from:'goal',to:'start',type:'next_step'}]};
  const failedResponse=await rpc('tools/call',{name:'adaptive_goal_graph_search',arguments:{graph:invalidGraph}});
  assert.equal(failedResponse.result?.isError,true,'invalid search contract reaches the real MCP error boundary');
  const failedMeta=failedResponse.result?.structuredContent?.agg_planner_telemetry;
  assert.equal(failedMeta?.persisted,true);assert.equal(failedMeta?.status,'failed');assert.ok(failedMeta.run_id);
  assert.equal(failedMeta.persistence_scope,'planner_telemetry_only');
  assert.equal(failedMeta.terminal_record_persisted,true,'failed searches still commit a terminal audit record');
  const verify=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const failed=verify.prepare('SELECT status,algorithm_status,error_code,error_name,finished_at,duration_ms FROM adaptive_goal_planner_runs WHERE run_id=?').get(failedMeta.run_id);
    assert.equal(failed.status,'failed');assert.equal(failed.algorithm_status,null,'pre-search validation errors do not fabricate an algorithm outcome');
    assert.ok(failed.finished_at);assert.ok(Number.isSafeInteger(failed.duration_ms)&&failed.duration_ms>=0);
    assert.equal(verify.prepare("SELECT event_type FROM adaptive_goal_planner_run_events WHERE run_id=? ORDER BY sequence DESC LIMIT 1").get(failedMeta.run_id).event_type,'run_failed');
    assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM adaptive_goal_planner_run_nodes WHERE run_id=?').get(failedMeta.run_id).n,2,'failed invocation keeps the pre-search input snapshot');
  }finally{verify.close();}
  console.log('PASS actual source MCP runtime: completed and failed AGG calls persist observed lifecycle, audit events, hashes, goal/node/evidence links and non-inferred metrics');
});
