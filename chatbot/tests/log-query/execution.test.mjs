// Synthetic execution evidence, actual CLI and SQLite. No external services or private data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createExecutionStore,executionSpan,readExecutionStore,readExecutionDetail} from '../../packages/observability/execution.js';
import {redactValue,createTraceSink,normalizeTraceEvent} from '../../packages/observability/index.js';
import {pairCalls} from '../../packages/log-query/log-query-views.mjs';
import {collectEvents,filterEvents,renderQuery} from '../../packages/log-query/index.js';
import {eventReference} from '../../packages/log-query/log-query-privacy.mjs';
import {LogQueryService} from '../../plugins/kurumi-logs/service.js';
const backend=path.resolve(import.meta.dirname,'../../..');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function sample(t){
  const root=fixture(t),dir=path.join(root,'documents','observability'),store=createExecutionStore(dir,{source:'papers'});t.after(()=>store.close());
  const span=(id,parent,type)=>executionSpan(store,{executionId:'paper:fixture',spanId:id,parentSpanId:parent,type,name:id,business:'papers'});
  span('root',null,'execution').emit('running');span('tool','root','tool').emit('completed');span('task','tool','task').emit('running');
  const api=span('api','task','api');
  const request=api.detail({model:'synthetic',input:'Synthetic request',max_output_tokens:300,authorization:'secret',password:'secret'});
  api.emit('running',{details:{request}});
  const response=api.detail({body:'Synthetic response',usage:{input_tokens:7,output_tokens:11}});
  api.emit('completed',{usage:{inputTokens:7,outputTokens:11,reasoningTokens:9},usageKnown:true,details:{response}});
  span('task','tool','task').emit('completed');span('root',null,'execution').emit('completed');
  return{root,store,request,response};
}
test('numeric usage survives credential redaction without opening numeric credential fields',()=>{
  assert.deepEqual(redactValue({inputTokens:12,output_tokens:13,max_output_tokens:14,api_token:123,token:'secret'}),{inputTokens:12,output_tokens:13,max_output_tokens:14,api_token:'[REDACTED]',token:'[REDACTED]'});
  assert.deepEqual(redactValue({output_tokens_details:{reasoning_tokens:7,api_key:'secret'}}),{output_tokens_details:{reasoning_tokens:7,api_key:'[REDACTED]'}});
});
test('tree represents async parentage and deduplicates usage across start and terminal snapshots',t=>{
  const f=sample(t),events=collectEvents({runtimeRoot:f.root,sources:['papers'],from:0,to:Date.now()+1000});
  const query=renderQuery(events,{tree:true,executionId:'paper:fixture',from:0,to:Date.now()+1000}).json;
  assert.equal(query.nodes.length,1);const root=query.nodes[0];assert.equal(root.usage.totalTokens,18);assert.equal(root.usage.requests,1);
  let current=root;
  for(const type of ['tool','task','api']){
    const value=renderQuery(events,{tree:true,nodeId:current.id,from:0,to:Date.now()+1000}).json;
    assert.equal(value.nodes.length,1);current=value.nodes[0];assert.equal(current.type,type);
  }
  const body=renderQuery(events,{tree:true,nodeId:current.id,detail:'request',from:0,to:Date.now()+1000}).json.detail;
  assert.equal(body.content.input,'Synthetic request');assert.equal(body.content.authorization,'[REDACTED]');
  const stats=renderQuery(events,{stats:true,from:0,to:Date.now()+1000}).json;
  assert.deepEqual(stats.backgroundUsage,{requests:1,unknownUsageRequests:0,inputTokens:7,outputTokens:11,reasoningTokens:9,totalTokens:18});
  const categories=renderQuery(events,{tree:true,from:0,to:Date.now()+1000}).json;
  assert.equal(categories.nodes[0].id,'business:papers');
  assert.equal(renderQuery(events,{tree:true,nodeId:'business:papers',from:0,to:Date.now()+1000}).json.nodes[0].id,root.id);
});
test('actual CLI adapter exposes the same authorized nodes and body evidence',async t=>{
  const f=sample(t),service=new LogQueryService({backendRoot:backend,runtimeRoot:f.root,snowlumaRoot:f.root});
  const args={sources:['papers'],view:'tree',since:'all',executionId:'paper:fixture'};
  const root=await service.query(args);assert.equal(root.nodes[0].usage.totalTokens,18);
  const all=readExecutionStore(f.store.file),target=all.find(e=>e.correlation.spanId==='api');
  const events=collectEvents({runtimeRoot:f.root,sources:['papers'],from:0,to:Date.now()+1000});
  const task=renderQuery(events,{tree:true,nodeId:root.nodes[0].id,from:0,to:Date.now()+1000}).json.nodes[0];
  const sub=await service.query({...args,nodeId:task.id});
  const api=(await service.query({...args,nodeId:sub.nodes[0].id})).nodes[0];
  const detail=await service.query({...args,nodeId:api.id,detail:'response'});
  assert.equal(detail.detail.content.body,'Synthetic response');assert.equal(target.data.type,'api');
});
test('retention, capacity and corrupt bodies never silently become empty success',t=>{
  const root=fixture(t);let now=Date.now();const store=createExecutionStore(root,{now:()=>now,limits:{retentionMs:100,bodyBytes:100}});t.after(()=>store.close());
  const ref=store.detail({text:'test'});assert.equal(readExecutionDetail(store.file,ref,{now}).content.text,'test');
  now+=101;assert.equal(readExecutionDetail(store.file,ref,{now}).status,'expired');
  assert.equal(store.detail({text:'x'.repeat(200)}).status,'too_large');
  const bad=path.join(root,'bad');fs.writeFileSync(bad,'invalid');const broken=createExecutionStore(bad,{onError:()=>{throw Error('observer failed');}});
  assert.equal(broken.detail({value:1}).status,'capture_failed');
});
test('unreadable and absent sources are visible; legacy jobs preserve request accounting without invented bodies',t=>{
  const root=fixture(t),agent=path.join(root,'agents/main/agent');fs.mkdirSync(agent,{recursive:true});fs.writeFileSync(path.join(agent,'openclaw-agent.sqlite'),'bad sqlite');
  const failed=collectEvents({runtimeRoot:root,sources:['openclaw-session','papers'],from:0,to:Date.now()});
  assert(failed.sourceStatus.some(s=>s.status==='read_failed'));assert(failed.sourceStatus.some(s=>s.status==='missing'));
  const jobs=path.join(root,'documents/jobs');fs.mkdirSync(jobs,{recursive:true});
  fs.writeFileSync(path.join(jobs,'job_'+'a'.repeat(24)+'.json'),JSON.stringify({id:'job_'+'a'.repeat(24),createdAt:new Date().toISOString(),status:'succeeded',usage:{receipts:[{attempt:1,batchId:1,usageStatus:'reported',usage:{input_tokens:12,output_tokens:20}}]}}));
  const events=collectEvents({runtimeRoot:root,sources:['papers'],from:0,to:Date.now()+1000});
  const stats=renderQuery(events,{stats:true,from:0,to:Date.now()+1000}).json;assert.equal(stats.backgroundUsage.totalTokens,32);
  assert(events.find(e=>e.data.type==='api').data.details.request.status==='not_collected');
});
test('event reference survives rotation and both projections',t=>{
  const root=fixture(t),file=path.join(root,'events.jsonl'),sink=createTraceSink(file,{maxBytes:1});
  sink.emit({source:'fixture',kind:'state',data:{status:'ok'}});
  const before=JSON.parse(fs.readFileSync(file,'utf8')),ref=eventReference(before);
  sink.emit({source:'fixture',kind:'state',data:{status:'ok'}});
  assert.equal(eventReference({...JSON.parse(fs.readFileSync(file+'.1','utf8')),sourceRef:{path:file+'.1',line:999}}),ref);
});
test('reused tool identifiers in different sessions do not merge inputs or results',()=>{
  const events=['a','b'].flatMap(session=>['agent.tool_call','agent.tool_result'].map(kind=>normalizeTraceEvent({source:'openclaw-session',kind,
    correlation:{sessionKey:session,toolCallId:'same-id'},data:{tool:'fixture',arguments:{value:session},status:'ok'}})));
  const calls=pairCalls(events);assert.equal(calls.length,2);assert.notEqual(calls[0].correlation.sessionKey,calls[1].correlation.sessionKey);
});
test('correlation closure scopes common span IDs to executions and tool IDs to sessions',()=>{
  const make=(executionId,sessionKey,runId)=>['root','request:1'].map(spanId=>normalizeTraceEvent({source:'papers',kind:'execution.node',
    correlation:{executionId,spanId,sessionKey,toolCallId:'same-tool',runId},data:{type:spanId==='root'?'execution':'api'}}));
  const first=make('paper:first','session:first','run:first'),second=make('paper:second','session:second','run:second');
  assert.deepEqual(filterEvents([...first,...second],{runId:'run:first'}),first);
});
test('peer filtering recognizes trusted subject IDs on background work',()=>{
  const values=['100001','100002'].map(subjectId=>normalizeTraceEvent({source:'papers',kind:'execution.node',correlation:{subjectId},data:{}}));
  assert.deepEqual(filterEvents(values,{peer:'100001'}),[values[0]]);
});
test('execution lookup restricts SQLite reads and reports missing legacy receipts',t=>{
  const f=sample(t);
  const targeted=collectEvents({runtimeRoot:f.root,sources:['papers'],executionId:'paper:absent',from:0,to:Date.now()+1000});
  assert.equal(targeted.length,0);
  const jobs=path.join(f.root,'documents/jobs');fs.mkdirSync(jobs);
  const id='job_'+'b'.repeat(24);
  fs.writeFileSync(path.join(jobs,id+'.json'),JSON.stringify({id,createdAt:new Date().toISOString(),status:'failed',usage:{requests:2}}));
  const events=collectEvents({runtimeRoot:f.root,sources:['papers'],executionId:'paper:'+id,from:0,to:Date.now()+1000});
  const root=renderQuery(events,{tree:true,executionId:'paper:'+id,from:0,to:Date.now()+1000}).json.nodes[0];
  assert.equal(root.captureStatus,'history_details_missing');
  assert.equal(root.usage.missingRequestDetails,2);assert(root.issues.includes('request_details_missing'));
});
test('Python evidence is readable through the same Node adapter and an untrusted file reference is rejected',t=>{
  const root=fixture(t),dir=path.join(root,'documents/observability');
  const py="import sys;sys.path.insert(0,sys.argv[1]);from trace_store import TraceStore;s=TraceStore(sys.argv[2],'cross-language','root');s.node('root','execution','fixture','running',parent='');r=s.detail({'input_tokens':19,'api_key':'secret','body':'fixture'});s.node('api','api','API','completed',parent='root',usage={'inputTokens':19,'outputTokens':3},usageKnown=True,details={'response':r})";
  const result=spawnSync('python3',['-c',py,path.join(backend,'chatbot/packages/observability'),dir],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const events=collectEvents({runtimeRoot:root,sources:['papers'],from:0,to:Date.now()+1000});
  const rendered=renderQuery(events,{tree:true,executionId:'cross-language',from:0,to:Date.now()+1000}).json;
  const rootNode=rendered.nodes.find(n=>n.type==='execution');
  const api=renderQuery(events,{tree:true,nodeId:rootNode.id,from:0,to:Date.now()+1000}).json.nodes[0];
  const body=renderQuery(events,{tree:true,nodeId:api.id,detail:'response',from:0,to:Date.now()+1000}).json.detail;
  assert.equal(body.content.input_tokens,19);assert.equal(body.content.api_key,'[REDACTED]');
  const forged=events.map(({...event})=>JSON.parse(JSON.stringify(event)));
  assert.equal(renderQuery(forged,{tree:true,nodeId:api.id,detail:'response',from:0,to:Date.now()+1000}).json.detail.status,'untrusted_reference');
});
