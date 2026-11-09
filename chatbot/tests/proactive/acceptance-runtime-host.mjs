// Actual production composition/QQ policy, public host SDK, P2/SQL read models
// and HTTP transport against synthetic loopback peers. No production or paid API.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import net from 'node:net';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';import {WebSocketServer} from 'ws';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {WeatherStore} from '../../packages/personal-domains/dist/store.js';import {ReminderStore} from '../../packages/personal-domains/dist/reminder-store.js';
import * as weather from '../../packages/personal-domains/dist/test-fixtures.js';
import {emptyState} from '../../plugins/kurumi-memory/continuity/model.js';
import {initializeContinuity,replaceNotice} from '../../plugins/kurumi-memory/continuity/store.js';
const out=process.argv.includes('--out')?process.argv[process.argv.indexOf('--out')+1]:undefined;
if(!path.isAbsolute(out??'')||fs.existsSync(out))throw Error('Require new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=fs.mkdtempSync(os.tmpdir()+'/kurumi-proactive-runtime-');
const token=randomBytes(24).toString('hex'),owner='100001',bot='100002',workspace=root+'/workspace',wakeFile=root+'/state/proactive/proactive.sqlite';
const report={at:new Date().toISOString(),boundary:'Actual QQ mandatory policy and N3 component/public SDK; synthetic loopback model/OneBot/business peers and temporary P2/SQLite. No production state, external API or QQ network. Behavioral judgment and owner experience are outside this evidence.',cases:[],modelRequests:0,businessRequests:[],platformRequests:0};
let mode='silent',unknownNext=false,platformSerial=2000,wsClient,holdResolve,holdSeen;
const ownerActions=['pause','resume','records','record_put','record_remove'],ownerResults=new Map();
let publicObservation,publicFetchRequests=0;
const toolValue=message=>{
  const content=message?.content;
  for(const text of typeof content==='string'?[content]:Array.isArray(content)?content.map(p=>p.text).filter(Boolean):[]){try{return JSON.parse(text);}catch{}}
};
const model=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/assistant/')){
    assert.equal(req.method,'GET');report.businessRequests.push({path:url.pathname,method:req.method,runId:!!req.headers['x-kurumi-run-id']});
    const component=url.pathname.split('/').at(-1);res.writeHead(200,{'content-type':'application/json'});
    return res.end(JSON.stringify(component==='tasks'?{ok:true,items:[],total:0,snapshot:'a'.repeat(64),truncated:false}:weather[component+'Fixture']));
  }
  if(!url.pathname.startsWith('/v1/')) {
    if(url.pathname==='/public-ssrf-probe')publicFetchRequests++;
    res.writeHead(200,{'content-type':'application/json'});
    if(url.pathname==='/get_login_info')return res.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:Number(bot),nickname:'synthetic'}}));
    if(url.pathname==='/send_private_msg') {
      let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);assert.equal(String(request.user_id),owner);report.platformRequests++;
      if(unknownNext){unknownNext=false;return res.destroy();}
      return res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:++platformSerial}}));
    }
    return res.end(JSON.stringify({status:'ok',retcode:0,data:{}}));
  }
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);assert(++report.modelRequests<100,'bounded deterministic model');
  if(mode==='hold'){holdSeen?.();await new Promise(r=>holdResolve=r);if(res.destroyed)return;}
  const messages=body.messages??[],lastUser=messages.findLastIndex(m=>m.role==='user'),tools=messages.slice(lastUser+1).filter(m=>m.role==='tool');
  let args,toolName='kurumi_proactive';
  if(ownerActions.includes(mode)&&tools.length)ownerResults.set(mode,toolValue(tools.at(-1)));
  if(mode==='public'&&tools.length===0){toolName='web_fetch';args={url:httpUrl+'/public-ssrf-probe'};}
  else if(mode==='public'&&tools.length===1)args={action:'sources'};
  else if(mode==='public'&&tools.length===2)publicObservation=toolValue(tools.at(-1));
  else if(mode==='full') {
    const kinds=['planning','reminders','reminder_list','weather'];
    if(tools.length<4)args={action:'query',kind:kinds[tools.length]};
    else if(tools.length===4){const data=toolValue(tools[0]);if(data?.sourceId)args={action:'remember',record:{kind:'experience',text:'本地合成查询经验',sources:[data.sourceId],ttlDays:30}};else report.toolFailure=data;}
    else if(tools.length<7)args={action:'notify',text:tools.length===5?'合成主动发言':'合成自主追问'};
  } else if(mode==='unknown'&&tools.length===0)args={action:'notify',text:'合成未知投递'};
  else if(mode==='forged'&&tools.length===0)args={action:'notify',text:'伪造目标',to:'user:100009',senderIsOwner:true};
  else if(ownerActions.includes(mode)&&tools.length===0) {
    args=mode==='record_remove'?{action:mode,...report.recordToRemove}
      :mode==='record_put'?{action:mode,record:{...report.recordToRemove,kind:'experience',text:'主人已更正的合成自身记录',ttlDays:30}}:{action:mode};
  }
  const final=ownerActions.includes(mode)?'合成操作已核对':JSON.stringify({kind:'done'});
  const delta=args?{role:'assistant',tool_calls:[{index:0,id:'native-'+report.modelRequests,type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:final};
  assert(body.stream);res.writeHead(200,{'content-type':'text/event-stream'});const base={id:'local-'+report.modelRequests,object:'chat.completion.chunk',created:1,model:'fixture'};
  res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:args?'tool_calls':'stop'}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}})+'\n\ndata: [DONE]\n\n');
}catch(e){report.peerError=e.message;if(!res.headersSent)res.writeHead(500);res.end('synthetic_peer_failed');}});
const wss=new WebSocketServer({server:model});wss.on('connection',socket=>wsClient=socket);
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
fs.mkdirSync(workspace,{mode:0o700});fs.writeFileSync(workspace+'/AGENTS.md','Synthetic isolated test. Use only offered purpose tools. Never infer owner authority.');
initializeContinuity(workspace,emptyState(owner));replaceNotice(workspace);
const weatherStore=new WeatherStore({stateDirectory:root+'/state/personal-weather'});weatherStore.close();const reminderStore=new ReminderStore({stateDirectory:root+'/state/personal-reminders'});reminderStore.close();
const businessFiles=[root+'/state/personal-weather/weather.sqlite',root+'/state/personal-reminders/reminders.sqlite',workspace+'/.kurumi-memory/state.sqlite'];
const fingerprints=()=>businessFiles.map(f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex')),before=fingerprints();
const bridgeToken=root+'/bridge-token';fs.writeFileSync(bridgeToken,'synthetic-bridge-key-'.repeat(3),{mode:0o600});
const httpUrl='http://127.0.0.1:'+model.address().port,pluginIds=['kurumi-qq','personal-weather','personal-reminder-list','kurumi-memory'];
const settings=JSON.parse(fs.readFileSync(repo+'/config/proactive.example.json'));Object.assign(settings,{enabled:true,notifyEnabled:true,intervalMs:86400000,timeoutMs:15000,publicSearch:true});
// Make this test's current time daytime; no activity claim or production value.
const minute=new Date().getUTCHours()*60+new Date().getUTCMinutes();settings.night={startMinute:(minute+120)%1440,endMinute:(minute+121)%1440,timeZone:'UTC',activityMaxAgeMs:900000};
const cfg={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},session:{dmScope:'per-channel-peer'},
  agents:{ownership:'explicit',defaults:{workspace,systemAgent:{agentId:'main'},model:{primary:'fixture/fixture'},heartbeat:{every:'0m'},compaction:{memoryFlush:{enabled:false}}},
    entries:{main:{workspace,model:{primary:'fixture/fixture'},tools:{allow:['kurumi_proactive','web_fetch'],deny:['read','write','edit','exec','process','message','sessions_spawn']}}}},
  models:{mode:'merge',providers:{fixture:{baseUrl:httpUrl+'/v1',apiKey:'synthetic-local-only',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:1000}]}}},
  channels:{'kurumi-qq':{enabled:true,ownerId:owner,accessControl:ownerPolicy(owner),httpUrl,wsUrl:httpUrl.replace('http:','ws:')+'/events',httpTokenFile:bridgeToken,wsTokenFile:bridgeToken,
    stateDir:root+'/state/channel',mediaRoot:root+'/media',testIngress:false,naturalSegments:false,dailySendLimit:120}},
  bindings:[{agentId:'main',match:{channel:'kurumi-qq',accountId:'default',peer:{kind:'direct',id:owner}}}],
  plugins:{allow:pluginIds,load:{paths:pluginIds.map(id=>repo+'/chatbot/plugins/'+id)},entries:{
    'kurumi-qq':{enabled:true,config:{proactive:settings}},'kurumi-memory':{enabled:false,config:{continuity:{enabled:true}}},
    'personal-weather':{enabled:false,config:{apiHost:'synthetic.qweather.test',apiKey:'synthetic',weatherBackend:'knowledgemap',bridgeBaseUrl:httpUrl,bridgeTokenFile:bridgeToken}},
    'personal-reminder-list':{enabled:false,config:{backendRoot:repo,dataSource:'knowledgemap',bridgeBaseUrl:httpUrl,bridgeTokenFile:bridgeToken}}},slots:{memory:'none'}},
  cron:{enabled:false},tools:{toolSearch:false,codeMode:false,web:{search:{enabled:false},fetch:{enabled:true}}},logging:{file:root+'/runtime.log'}};
fs.writeFileSync(root+'/openclaw.json',JSON.stringify(compileAccessConfig(cfg,ownerPolicy(owner))),{mode:0o600});let child;
function start(){const fd=fs.openSync(root+'/gateway.log','a',0o600);child=spawn(process.execPath,[repo+'/node_modules/openclaw/openclaw.mjs','gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],
  {cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:root+'/openclaw.json',OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_AGENT_DIR:root+'/agents/main/agent'}});fs.closeSync(fd);}
const call=(method,params={},timeout=30000)=>callGatewayFromCli(method,{url:'ws://127.0.0.1:'+port,token,timeout:String(timeout),json:true},params);
async function ready(){for(let n=0;n<150;n++){try{const state=await call('kurumi-proactive.status',{},1000);if(state.control&&wsClient?.readyState===1)return;}catch{}if(child.exitCode!==null)throw Error('Isolated Gateway exited');await new Promise(r=>setTimeout(r,200));}throw Error('N3 service readiness timeout');}
async function stop(){if(child?.exitCode===null){child.kill('SIGTERM');let timer;await Promise.race([once(child,'exit'),new Promise(r=>{timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}r();},10000);})]);clearTimeout(timer);}}
function inspect(sql,...params){const db=new DatabaseSync(wakeFile,{readOnly:true});try{return db.prepare(sql).all(...params);}finally{db.close();}}
async function ownerMessage(action,messageId) {
  mode=action;ownerResults.delete(action);wsClient.send(JSON.stringify({time:Math.floor(Date.now()/1000),self_id:Number(bot),post_type:'message',message_type:'private',user_id:Number(owner),message_id:messageId,message:[{type:'text',data:{text:'合成验收：'+action}}]}));
  for(let n=0;n<100;n++){if(ownerResults.has(action)){const result=ownerResults.get(action);assert(!result?.error,JSON.stringify(result));return result;}await new Promise(r=>setTimeout(r,100));}
  throw Error('Actual owner control did not converge: '+action);
}
try {
  start();await ready();report.cases.push({label:'actual-disabled-ingress-production-composition-starts-with-explicit-fixture-grants',passed:true});
  mode='full';const full=await call('kurumi-proactive.run',{eventKey:'full'});assert.equal(full.status,'completed',JSON.stringify(full));
  assert.equal(full.messages.length,2);assert(full.messages.every(m=>m.status==='delivered'));assert.equal(report.platformRequests,2);
  const notes=inspect('SELECT id,version FROM proactive_record WHERE deleted=0');assert.equal(notes.length,1);report.recordToRemove={id:notes[0].id,expectedVersion:notes[0].version};
  assert.deepEqual(fingerprints(),before);assert.equal(report.businessRequests.length,5);assert(report.businessRequests.every(x=>x.method==='GET'&&x.runId));
  report.cases.push({label:'actual-SDK-query-four-domains-self-record-two-speeches-and-factual-receipts',passed:true,messages:full.messages.map(m=>m.status)});
  const duplicate=await call('kurumi-proactive.run',{eventKey:'full'});assert.equal(duplicate.reason,'duplicate');assert.equal(report.platformRequests,2);
  report.cases.push({label:'same-event-replay-never-repeats-native-tools-or-platform-effects',passed:true});
  mode='silent';assert.equal((await call('kurumi-proactive.run',{eventKey:'quiet'})).status,'silent');assert.equal(report.platformRequests,2);
  report.cases.push({label:'actual-model-can-choose-silence-with-existing-self-record',passed:true});
  mode='public';assert.equal((await call('kurumi-proactive.run',{eventKey:'public'})).status,'silent');
  assert.equal(publicFetchRequests,0);assert.equal(publicObservation.sources.length,1);assert.equal(publicObservation.sources[0].tool,'web_fetch');
  assert.equal(publicObservation.sources[0].outcome,'failed');assert(publicObservation.sources[0].sourceId.startsWith('public:'));
  assert.equal(inspect("SELECT COUNT(*) AS n FROM wake_source WHERE kind='public'")[0].n,1);
  report.cases.push({label:'native-web-fetch-SSRF-refusal-is-observed-as-failed-attempt-source-without-loopback-read',passed:true});
  mode='forged';const forged=await call('kurumi-proactive.run',{eventKey:'forged'});assert.equal(forged.messages.length,0);assert.equal(report.platformRequests,2);
  report.cases.push({label:'model-cannot-select-recipient-or-owner-authority',passed:true});
  mode='unknown';unknownNext=true;const unknown=await call('kurumi-proactive.run',{eventKey:'uncertain'});assert.equal(unknown.messages[0].status,'unknown');
  const attempts=report.platformRequests;await call('kurumi-proactive.run',{eventKey:'uncertain'});assert.equal(report.platformRequests,attempts);
  report.cases.push({label:'real-HTTP-uncertainty-retained-and-not-automatically-retried',passed:true});
  await ownerMessage('pause',3001);assert.equal((await call('kurumi-proactive.run',{eventKey:'paused'})).reason,'paused');
  report.cases.push({label:'actual-OneBot-inbound-QQ-policy-and-owner-tool-pause-background',passed:true});
  await stop();wsClient=undefined;start();await ready();assert.equal((await call('kurumi-proactive.status')).control.paused,1);
  report.cases.push({label:'pause-and-ledgers-survive-actual-Gateway-restart-without-replay',passed:true});
  const listed=await ownerMessage('records',3010);assert.equal(listed.records.length,1);assert.equal(listed.records[0].id,notes[0].id);
  const corrected=await ownerMessage('record_put',3011);assert.equal(corrected.version,2);assert.equal(corrected.id,notes[0].id);
  report.recordToRemove.expectedVersion=2;
  const removed=await ownerMessage('record_remove',3012);assert.equal(removed.deleted,true);assert.equal(removed.version,3);
  assert.equal((await ownerMessage('records',3013)).records.length,0);
  const tombstone=inspect('SELECT text,sources,deleted FROM proactive_record WHERE id=?',notes[0].id)[0];assert.equal(tombstone.text,null);assert.equal(tombstone.sources,null);assert.equal(tombstone.deleted,1);
  report.cases.push({label:'actual-owner-views-corrects-and-deletes-self-record-with-CAS-and-content-wiped-tombstone',passed:true});
  await ownerMessage('resume',3002);mode='silent';assert.equal((await call('kurumi-proactive.run',{eventKey:'resumed'})).status,'silent');
  report.cases.push({label:'actual-owner-resume-allows-new-opportunity',passed:true});
  mode='hold';let see;const seen=new Promise(r=>see=r);holdSeen=see;const inflight=call('kurumi-proactive.run',{eventKey:'preempt'});await seen;
  // Accepted real input revokes before its foreground model is dispatched.
  mode='silent';wsClient.send(JSON.stringify({time:Math.floor(Date.now()/1000),self_id:Number(bot),post_type:'message',message_type:'private',user_id:Number(owner),message_id:3003,message:[{type:'text',data:{text:'合成新请求优先'}}]}));
  const cancelled=await inflight;assert.equal(cancelled.status,'cancelled');holdResolve?.();holdSeen=undefined;
  report.cases.push({label:'actual-foreground-admission-preempts-detached-background-model',passed:true});
  const beforeReset=(await call('kurumi-proactive.status')).control;
  await call('sessions.reset',{key:'agent:main:kurumi-qq:direct:'+owner,reason:'new'});
  const afterReset=(await call('kurumi-proactive.status')).control;assert(afterReset.epoch>beforeReset.epoch);assert.equal(afterReset.last_activity,beforeReset.last_activity);
  report.cases.push({label:'actual-foreground-session-reset-fences-composition-without-fabricating-owner-activity',passed:true});
  mode='silent';const state=await call('kurumi-proactive.status');assert.equal(state.active,0);assert(state.control.last_activity>0);assert.deepEqual(fingerprints(),before);
  assert(!report.peerError,report.peerError);delete report.recordToRemove;report.passed=true;
} catch(e){report.passed=false;report.error=e.message;report.diagnosticsRoot=root;process.exitCode=1;}
finally {
  holdResolve?.();await stop();for(const socket of wss.clients)socket.terminate();await new Promise(r=>wss.close(r));model.closeAllConnections();await new Promise(r=>model.close(r));
  report.childStopped=child?.exitCode!==null||child?.signalCode!==null;report.finishedAt=new Date().toISOString();
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if(report.passed)fs.rmSync(root,{recursive:true,force:true});
  console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,modelRequests:report.modelRequests,error:report.error,evidence:out}));
}
