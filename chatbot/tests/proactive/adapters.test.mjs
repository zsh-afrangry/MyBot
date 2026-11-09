// Real domain read models and loopback business API, never production state.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import http from 'node:http';
import {createHash} from 'node:crypto';
import {WeatherStore} from '../../packages/personal-domains/dist/store.js';
import {ReminderStore} from '../../packages/personal-domains/dist/reminder-store.js';
import * as weatherFixtures from '../../packages/personal-domains/dist/test-fixtures.js';
import {createDomainAdapters} from '../../plugins/kurumi-qq/proactive/adapters.js';
import {createProactiveComponent,validateSettings} from '../../plugins/kurumi-qq/proactive/index.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {emptyState} from '../../plugins/kurumi-memory/continuity/model.js';
import {initializeContinuity,replaceNotice} from '../../plugins/kurumi-memory/continuity/store.js';
import {toolPermission,toolPolicyDecision} from '../../packages/access-control/index.js';
import {createTraceSink} from '../../packages/observability/index.js';
import {collectEvents} from '../../../scripts/fusion/log-query.mjs';
import {collectErrors} from '../../../scripts/fusion/log-query-views.mjs';
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(os.tmpdir()+'/kurumi-proactive-adapters-'),workspace=root+'/workspace';fs.mkdirSync(workspace,{mode:0o700});
  const w=new WeatherStore({stateDirectory:root+'/state/personal-weather'});w.close();
  const r=new ReminderStore({stateDirectory:root+'/state/personal-reminders'});r.close();
  initializeContinuity(workspace,emptyState('100001'));replaceNotice(workspace);
  const cfg={channels:{'kurumi-qq':{ownerId:'100001',accessControl:ownerPolicy('100001')}},agents:{entries:{main:{workspace}}},plugins:{entries:{'kurumi-memory':{config:{continuity:{enabled:true}}}}}};
  const adapters=createDomainAdapters({getConfig:()=>cfg,ownerId:'100001',stateRoot:root});
  const files=[root+'/state/personal-weather/weather.sqlite',root+'/state/personal-reminders/reminders.sqlite',workspace+'/.kurumi-memory/state.sqlite'];
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,cfg,adapters,files};
}
test('P2, planning and reminders use existing read-only data without changing business databases',async t=>{
  const f=fixture(t),before=f.files.map(sha),options={verify(){},signal:new AbortController().signal,runId:'actual-host-run'};
  assert.equal(f.adapters.memory().generation,0);
  const planning=await f.adapters.query('planning',options);assert(planning.profile.currentLocation);assert(Array.isArray(planning.trips));assert.equal(planning.capabilities,undefined);
  const reminders=await f.adapters.query('reminders',options);assert.deepEqual(reminders.activeReminders,[]);
  assert.deepEqual(f.files.map(sha),before);
});
test('read-only stores do not create missing directories and SQLite rejects attempted mutation',t=>{
  const f=fixture(t),missing=f.root+'/missing';
  assert.throws(()=>new WeatherStore({stateDirectory:missing,readOnly:true}));assert(!fs.existsSync(missing));
  assert.throws(()=>new ReminderStore({stateDirectory:missing,readOnly:true}));assert(!fs.existsSync(missing));
  const store=new WeatherStore({stateDirectory:f.root+'/state/personal-weather',readOnly:true});
  try{assert.throws(()=>store.deleteExpiredApiCache(Number.MAX_SAFE_INTEGER),/readonly/i);}finally{store.close();}
  const link=f.root+'/link';fs.symlinkSync(f.root+'/state/personal-weather',link);
  assert.throws(()=>new WeatherStore({stateDirectory:link,readOnly:true}));
});
test('actual weather adapter and remote list use GET-only fixed API, current run correlation and immutable SQLite',async t=>{
  const f=fixture(t),requests=[],credential='synthetic-local-key-'.repeat(3),tokenFile=f.root+'/bridge-token';fs.writeFileSync(tokenFile,credential,{mode:0o600});
  const server=http.createServer(async(req,res)=>{
    requests.push({method:req.method,path:new URL(req.url,'http://127.0.0.1').pathname,runId:req.headers['x-kurumi-run-id']});
    assert.equal(req.headers.authorization,'Bearer '+credential);res.writeHead(200,{'content-type':'application/json'});
    const component=req.url.split('/').at(-1).split('?')[0];
    res.end(JSON.stringify(component==='tasks'?{ok:true,items:[],total:0,truncated:false,snapshot:'a'.repeat(64)}:weatherFixtures[component+'Fixture']));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const bridge={bridgeBaseUrl:'http://127.0.0.1:'+server.address().port,bridgeTokenFile:tokenFile};
  f.cfg.plugins.entries['personal-weather']={config:{...bridge,weatherBackend:'knowledgemap'}};
  f.cfg.plugins.entries['personal-reminder-list']={config:{...bridge,dataSource:'knowledgemap'}};
  const before=f.files.map(sha),options={verify(){},runId:'host-minted-id'};
  const brief=await f.adapters.query('weather',options);assert(brief.location);assert(brief.current);
  const list=await f.adapters.query('reminder_list',options);assert.deepEqual(list,{items:[],total:0,truncated:false});
  assert.equal(requests.length,5);assert(requests.every(r=>r.method==='GET'&&r.runId==='host-minted-id'));assert.deepEqual(f.files.map(sha),before);
});
test('revoked domain permission and N2 adapter never acquire read authority through N3',async t=>{
  const f=fixture(t);f.cfg.channels['kurumi-qq'].accessControl.subjects[0].permissions['planning.read']=false;
  await assert.rejects(()=>f.adapters.query('planning',{verify(){}}),/capability_not_allowed/);
  await assert.rejects(()=>f.adapters.query('bills',{verify(){}}),/wake_query_not_allowed/);
  f.cfg.plugins.entries['kurumi-memory'].config.system={enabled:true};assert.throws(()=>f.adapters.memory(),/wake_memory_adapter_not_supported/);
});
test('disabled/discovery plugin registration creates no state, service, hooks or capabilities',t=>{
  const root=fs.mkdtempSync(os.tmpdir()+'/kurumi-proactive-disabled-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fail=()=>assert.fail('Disabled plugin performed registration/effect');
  createProactiveComponent({stateRoot:root}).register({pluginConfig:{proactive:{enabled:false}},registerTool:fail,registerService:fail,on:fail});
  assert.deepEqual(fs.readdirSync(root),[]);
  const config=JSON.parse(fs.readFileSync(new URL('../../../config/proactive.example.json',import.meta.url)));config.enabled=true;
  const f=fixture(t);let tools=0;
  createProactiveComponent({stateRoot:root,getConfig:()=>f.cfg}).register({registrationMode:'tool-discovery',pluginConfig:{proactive:config},config:f.cfg,runtime:{agent:{}},registerTool(){tools++;},registerService:fail,on:fail});
  assert.equal(tools,1);assert.deepEqual(fs.readdirSync(root),[]);
});
test('new purpose vocabulary is explicit and never inferred from existing owner role',()=>{
  const cfg={channels:{'kurumi-qq':{ownerId:'100001',accessControl:ownerPolicy('100001')}}};
  delete cfg.channels['kurumi-qq'].accessControl.subjects[0].permissions['proactive.use'];
  const ctx={agentId:'main',sessionKey:'agent:main:kurumi-qq:direct:100001',requester:{channel:'kurumi-qq',senderId:'100001',senderIsOwner:true}};
  assert.equal(toolPolicyDecision({toolName:'kurumi_proactive',params:{action:'query'}},ctx,cfg).block,true);
  assert.equal(toolPermission('kurumi_proactive',{action:'invented'}),undefined);
  assert.equal(toolPermission('kurumi_proactive',{action:'notify'}),'proactive.notify');
});
test('invalid fixed/night parameters fail before service startup',()=>{
  const value=JSON.parse(fs.readFileSync(new URL('../../../config/proactive.example.json',import.meta.url)));value.enabled=true;
  assert.equal(validateSettings(value),value);
  for(const patch of [{intervalMs:1},{timeoutMs:0},{reads:['mail']},{reads:['weather','weather']},{night:{...value.night,timeZone:'invalid'}}])assert.throws(()=>validateSettings({...value,...patch}));
});
test('existing log API queries N3 structured events and reports unknown delivery without exposing content',t=>{
  const f=fixture(t),at=Date.now(),sink=createTraceSink(f.root+'/state/proactive/trace.jsonl',{maxBytes:4096});
  sink.emit({source:'proactive',kind:'proactive.delivery',epochMs:at,correlation:{runId:'actual'},data:{status:'unknown',key:'call'}});
  const events=collectEvents({from:at-1,to:at+1,runtimeRoot:f.root,sources:['proactive']});assert.equal(events.length,1);assert.equal(events[0].correlation.runId,'actual');
  assert.equal(collectErrors(events).items[0].code,'wake_delivery_unknown');
});
test('composition accepts only matched owner lifecycle metadata and clears exact owner/background scopes',async t=>{
  const f=fixture(t),settings=JSON.parse(fs.readFileSync(new URL('../../../config/proactive.example.json',import.meta.url)));settings.enabled=true;
  f.cfg.plugins.entries['kurumi-qq']={config:{proactive:settings}};f.cfg.agents.entries.main.tools={};
  const hooks=new Map();let service;
  const provider=createProactiveComponent({stateRoot:f.root,getConfig:()=>f.cfg,adapters:f.adapters,host:{}}).register({
    config:f.cfg,pluginConfig:{proactive:settings},on(name,handler){hooks.set(name,handler);},registerService(value){service=value;},registerTool(){},registerGatewayMethod(){}});
  assert.throws(()=>service.start(),/wake_tool_not_allowed/);assert(!fs.existsSync(f.root+'/state/proactive'));
  f.cfg.agents.entries.main.tools={alsoAllow:['kurumi_proactive']};service.start();t.after(()=>service.stop());
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(f.root+'/state/proactive/proactive.sqlite',{readOnly:true});t.after(()=>db.close());
  const epoch=()=>db.prepare('SELECT epoch FROM wake_control WHERE scope=?').get('qq:user:100001')?.epoch??0;
  const key='agent:main:kurumi-qq:direct:100001',before=epoch();
  hooks.get('before_reset')({sessionKey:key},{sessionKey:'agent:main:other',agentId:'main'});
  hooks.get('session_end')({sessionKey:key},{sessionKey:key,agentId:'member'});
  provider.acceptInbound({origin:'onebot',subjectId:'100001',agentId:'member',sessionKey:key});assert.equal(epoch(),before);
  hooks.get('before_reset')({sessionKey:key},{sessionKey:key,agentId:'main'});assert.equal(epoch(),before+1);
  hooks.get('session_end')({sessionKey:'agent:main:kurumi-proactive:100001'},{agentId:'main'});assert.equal(epoch(),before+2);
});
