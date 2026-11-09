// Real isolated Gateway: captured plugin, QQ mandatory policy, deterministic local
// model, actual tool/CLI execution and loopback replies. No real model/API/QQ or production writes.
// Writes only temporary state/processes and the explicitly supplied new --out evidence file.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import net from 'node:net';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {randomBytes,createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';import {WebSocketServer} from 'ws';import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {compileAccessConfig} from '../../packages/access-control/config.js';
const out=process.argv[process.argv.indexOf('--out')+1];
if(!process.argv.includes('--out')||!path.isAbsolute(out??'')||fs.existsSync(out))throw Error('Require a new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-logs-host-'));
const report={at:new Date().toISOString(),boundary:'Real isolated Gateway/captured plugin, actual QQ mandatory policy and owner ingress, deterministic local model, fixed CLI read of synthetic logs, loopback replies and enabled/disabled lifecycle. No model provider, no external API, no QQ network, no production write or production service restart.',stages:[]};
async function run(enabled){
 const directory=path.join(root,enabled?'enabled':'disabled');fs.mkdirSync(directory);
 const state=path.join(directory,'host'),source=path.join(directory,'query-data'),token=randomBytes(24).toString('hex'),owner='100001',bot='100002';fs.mkdirSync(state);
 const stage={enabled,queries:[],modelRequests:0};report.stages.push(stage);
 let socket,peer,wss,child;const replies=new Set();let seq=100,modelError;
 const queries={default:{},six_hours:{since:'6h',view:'events',limit:20},stats:{view:'stats',since:'6h'},errors:{view:'errors',sources:['trace-events']},summary:{view:'errors',sources:['trace-events'],noText:true},keywords:{sources:['trace-events'],keywords:['STACK_ONLY_MARKER','中文/原因'],keywordMode:'all',noText:true},context:{sources:['snowluma'],contains:'OidbError',contextBefore:1,contextAfter:1,expand:true},history:{sources:['trace-events'],since:'all',contains:'HISTORY_RETAINED'},large:{sources:['trace-events'],contains:'LONG_RECORD',expand:true,limit:1}};
 const toolText=value=>{
  if(Array.isArray(value))return value.map(toolText).join('\n');
  if(value && typeof value==='object')return value.text ?? (value.content ? toolText(value.content) : JSON.stringify(value));
  if(typeof value==='string'){try{const parsed=JSON.parse(value);if(parsed && typeof parsed==='object')return toolText(parsed);}catch{}return value;}
  return String(value);
 };
 const parseResult=text=>{const start=text.search(/\{\s*"status"\s*:\s*"ok"/);assert(start>=0,'missing_result_object');return JSON.parse(text.slice(start,text.lastIndexOf('}')+1));};
 let toolCalls=0;const expectedLong='LONG_RECORD '+ '龘𠀀😀中文\n\"'.repeat(600)+' END_LONG';
 const fixture=path.join(source,'channel/trace-events.jsonl');let before;
 if(enabled){
  fs.mkdirSync(path.dirname(fixture),{recursive:true});const at=new Date(Date.now()-60000).toISOString();
  fs.writeFileSync(fixture,[{source:'reminder-list',kind:'reminder-list.notice.generation_failed',data:{status:'generation_failed',text:'PRIVATE_SYNTHETIC_BODY',apiKey:'PRIVATE_SYNTHETIC_KEY',code:'中文/原因 空格:失败',deep:{stack:'STACK_ONLY_MARKER'}}},{source:'e7',kind:'e7.http',data:{httpStatus:304}},{source:'e7',kind:'e7.http',data:{httpStatus:500}}].map(e=>JSON.stringify({schemaVersion:1,at,...e})).join('\n')+'\n');
  fs.appendFileSync(fixture,JSON.stringify({schemaVersion:1,at:new Date(Date.now()-40*86400000).toISOString(),source:'fixture',kind:'fixture.history',data:{text:'HISTORY_RETAINED'}})+'\n');
  fs.appendFileSync(fixture,JSON.stringify({schemaVersion:1,at,source:'fixture',kind:'fixture.long',data:{body:expectedLong}})+'\n');
  const nativeDir=path.join(source,'runtime/logs');fs.mkdirSync(nativeDir,{recursive:true});
  const localTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(Date.now()-60000)),day=localTime.slice(0,10),clock=localTime.slice(11);
  fs.writeFileSync(path.join(nativeDir,'snowluma-'+day+'.log'),clock+' INFO BEFORE_ONLY\n'+clock+' ERROR OidbError\n    at /synthetic/stack.js:9\n'+clock+' INFO AFTER_ONLY\n');
  const sourceHash=()=>createHash('sha256').update(fs.readFileSync(fixture)).update(fs.readFileSync(path.join(nativeDir,'snowluma-'+day+'.log'))).digest('hex');
  before=sourceHash();stage.sourceHash=sourceHash;
  peer=http.createServer(async(req,res)=>{try{
   let raw='';for await(const x of req)raw+=x;const body=JSON.parse(raw||'{}');
   if(req.url.startsWith('/v1/')){
    assert(++stage.modelRequests<=160,'too_many_fixture_requests');
    const messages=body.messages??[],index=messages.findLastIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes('LOG_CASE:'));
    const mode=/LOG_CASE:(\w+)/.exec(JSON.stringify(messages[index]?.content))?.[1];assert(mode&&queries[mode]);
    const tools=messages.slice(index+1).filter(m=>m.role==='tool');let delta;
    if(!tools.length){assert((body.tools??[]).some(t=>t.function?.name==='kurumi_logs'),'logs_tool_not_offered');delta={role:'assistant',tool_calls:[{index:0,id:'log-'+stage.modelRequests,type:'function',function:{name:'kurumi_logs',arguments:JSON.stringify(queries[mode])}}]};}
    else{
     const results=tools.map(t=>{const text=toolText(t.content);assert.match(text,/stored_events_only/);assert.match(text,/EXTERNAL_UNTRUSTED_CONTENT/);assert(!/query_failed|access_denied/.test(text));assert(Buffer.byteLength(text)<=24*1024);return parseResult(text);}),last=results.at(-1);
     if(last.chunked && last.nextContentOffset!==null){
      delta={role:'assistant',tool_calls:[{index:0,id:'log-'+stage.modelRequests,type:'function',function:{name:'kurumi_logs',arguments:JSON.stringify({...queries[mode],since:undefined,from:last.from,to:last.to,contentOffset:last.nextContentOffset,contentHash:last.contentHash})}}]};
     }else{
      const result=results[0].chunked?JSON.parse(results.map(r=>r.contentFragment).join('')):last,serial=JSON.stringify(result);
      if(['default','six_hours','errors'].includes(mode)){assert.match(serial,/PRIVATE_SYNTHETIC_BODY/);assert.match(serial,/PRIVATE_SYNTHETIC_KEY/);}
      if(mode==='summary'||mode==='keywords'){assert(!serial.includes('PRIVATE_SYNTHETIC'));assert(!serial.includes('STACK_ONLY_MARKER'));}
      if(mode==='errors'){assert.match(serial,/generation_failed/);assert(result.items.some(i=>i.code==='中文/原因 空格:失败'));}
      if(mode==='keywords')assert.equal(result.total,1);
      if(mode==='context'){assert.equal(result.contextEvents.length,3);assert.match(serial,/BEFORE_ONLY/);assert.match(serial,/AFTER_ONLY/);assert.match(serial,/stack.js:9/);}
      if(mode==='history'){assert.equal(result.total,1);assert.match(serial,/HISTORY_RETAINED/);}
      if(mode==='large')assert.equal(result.events[0].data.body,expectedLong);
      toolCalls+=tools.length;stage.queries.push({mode,passed:true,fragments:tools.length,completeContentVerified:true});delta={role:'assistant',content:'LOG_OK:'+mode};
     }
    }
    assert(body.stream);res.writeHead(200,{'content-type':'text/event-stream'});const base={id:'log-local-'+stage.modelRequests,object:'chat.completion.chunk',created:1,model:'fixture'};
    res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4}})+'\n\ndata: [DONE]\n\n');return;
   }
   assert.equal(req.headers.authorization,'Bearer '+token);let data={};
   if(req.url==='/get_login_info')data={user_id:Number(bot)};
   if(req.url==='/get_status')data={online:true,good:true};
   if(req.url==='/send_private_msg'){assert.equal(String(body.user_id),owner);const mode=/LOG_OK:(\w+)/.exec(JSON.stringify(body.message))?.[1];if(mode)replies.add(mode);data={message_id:++seq};}
   res.end(JSON.stringify({status:'ok',retcode:0,data}));
  }catch(e){modelError=e.message;if(!res.headersSent)res.writeHead(500);res.end('fixture_failed');}});
  wss=new WebSocketServer({server:peer});wss.on('connection',ws=>socket=ws);await new Promise(r=>peer.listen(0,'127.0.0.1',r));
 }
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const workspace=path.join(state,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(workspace+'/AGENTS.md','Use only the offered tool for the synthetic log query.');
 let cfg={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},agents:{ownership:'explicit',defaults:{workspace,systemAgent:{agentId:'main'},heartbeat:{every:'0m'},compaction:{memoryFlush:{enabled:false}}},entries:{main:{workspace,tools:{allow:['kurumi_logs'],deny:['read','write','edit','exec','process','message','sessions_spawn']}}}},
  plugins:{allow:['kurumi-logs'],load:{paths:[repo+'/chatbot/plugins/kurumi-logs']},entries:{'kurumi-logs':{enabled,config:{backendRoot:repo,runtimeRoot:source,snowlumaRoot:source}}},slots:{memory:'none'}},cron:{enabled:false},tools:{toolSearch:false,codeMode:false,web:{search:{enabled:false},fetch:{enabled:false}}},logging:{file:state+'/runtime.log'}};
 if(enabled){
  const url='http://127.0.0.1:'+peer.address().port;
  cfg.models={providers:{fixture:{baseUrl:url+'/v1',apiKey:'synthetic',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:1000}]}}};
  cfg.agents.defaults.model={primary:'fixture/fixture'};cfg.agents.entries.main.model={primary:'fixture/fixture'};cfg.session={dmScope:'per-channel-peer'};
  cfg.channels={'kurumi-qq':{enabled:true,httpUrl:url,wsUrl:url.replace('http:','ws:')+'/events',httpTokenFile:state+'/http-token',wsTokenFile:state+'/ws-token',stateDir:state+'/channel',mediaRoot:state+'/media',testIngress:false,naturalSegments:false,dailySendLimit:20}};
  for(const name of ['http-token','ws-token'])fs.writeFileSync(state+'/'+name,token,{mode:0o600});
  cfg.plugins.allow.push('kurumi-qq');cfg.plugins.load.paths.push(repo+'/chatbot/plugins/kurumi-qq');cfg.plugins.entries['kurumi-qq']={enabled:true};
  cfg=compileAccessConfig(cfg,{version:1,revision:1,subjects:[{qq:owner,kind:'user',role:'owner',enabled:true,permissions:{'chat.use':true,'qq.reply':true,'logs.read':true},mailRecipients:[]}]});
 }
 fs.writeFileSync(state+'/openclaw.json',JSON.stringify(cfg),{mode:0o600});const fd=fs.openSync(directory+'/gateway.log','w',0o600);
 child=spawn(process.execPath,[repo+'/node_modules/openclaw/openclaw.mjs','gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:state,LANG:'C.UTF-8',OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:state+'/openclaw.json',OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_AGENT_DIR:state+'/agents/main/agent'}});fs.closeSync(fd);
 const call=(method,params={},timeout=10000)=>callGatewayFromCli(method,{url:'ws://127.0.0.1:'+port,token,timeout:String(timeout),json:true},params);
 try{
  let ready=false;for(let n=0;n<100;n++){try{await call('health',{},1000);if(!enabled||socket?.readyState===1){ready=true;break;}}catch{}if(child.exitCode!==null)throw Error('Isolated Gateway exited');await new Promise(r=>setTimeout(r,200));}assert(ready,'Gateway readiness timed out');
  const plugins=await call('plugins.list'),catalog=await call('tools.catalog',{agentId:'main',includePlugins:true});const plugin=plugins.plugins.find(p=>p.id==='kurumi-logs');assert(plugin);
  const names=catalog.groups.filter(g=>g.pluginId==='kurumi-logs').flatMap(g=>g.tools.map(t=>t.id));
  if(enabled){
   assert.equal(plugin.runtime.state,'active');assert.deepEqual(names,['kurumi_logs']);
   assert(fs.readdirSync(state+'/tmp',{recursive:true}).some(p=>String(p).includes('node_modules/kurumi-logs/query.js')),'captured plugin missing');stage.capturedModuleObserved=true;
   for(const mode of Object.keys(queries)){
    socket.send(JSON.stringify({time:Math.floor(Date.now()/1000),self_id:Number(bot),post_type:'message',message_type:'private',user_id:Number(owner),message_id:++seq,message:[{type:'text',data:{text:'LOG_CASE:'+mode}}]}));
    for(let n=0;n<400&&!replies.has(mode);n++){if(modelError)throw Error(modelError);await new Promise(r=>setTimeout(r,100));}assert(replies.has(mode),'actual owner reply missing: '+mode);
   }
   const audit=fs.readFileSync(state+'/channel/trace-events.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(e=>e.kind==='logs.query');
   assert.equal(audit.length,toolCalls);assert(audit.every(e=>e.data.status==='ok'));assert(!JSON.stringify(audit).includes('PRIVATE_SYNTHETIC'));assert.equal(stage.sourceHash(),before);delete stage.sourceHash;
   stage.ownerQueriesAudited=toolCalls;stage.loopbackReplies=replies.size;stage.sourceUnchanged=true;stage.testIngressDisabled=true;
  }else{assert(['disabled','unloaded'].includes(plugin.runtime.state));assert.deepEqual(names,[]);assert.equal(fs.existsSync(source),false);stage.noInitialFetch=true;}
  Object.assign(stage,{state:plugin.runtime.state,tools:names,passed:true});
 }catch(error){stage.failure={name:error.name,message:modelError ?? error.message};throw error;}finally{
  const exited=once(child,'exit');let killed=false;try{process.kill(-child.pid,'SIGTERM');}catch{}
  const timer=setTimeout(()=>{killed=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},8000);timer.unref();if(child.exitCode===null&&child.signalCode===null)await exited;clearTimeout(timer);stage.gracefulStop=!killed;
  if(wss){for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));peer.closeAllConnections();await new Promise(r=>peer.close(r));}
  if(killed && !stage.failure)throw Error('Isolated Gateway did not stop gracefully');
 }
}
try{await run(true);await run(false);report.passed=true;}catch(e){report.passed=false;report.error={name:e.name,message:e.message};process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();if(report.passed)fs.rmSync(root,{recursive:true,force:true});else report.diagnosticDirectory=root;fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:report.passed,stages:report.stages.length,error:report.error}));}
