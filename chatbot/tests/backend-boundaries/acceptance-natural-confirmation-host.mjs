// Real isolated Gateway, typed hooks, deferred tools, SQLite and loopback OneBot.
// Cognition is deterministic. No model API, real QQ/SMTP or production state writes.
// Requires a new absolute --out evidence file; failed fixtures stay in /tmp for diagnosis.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {WebSocketServer} from 'ws';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import assert from 'node:assert/strict';

const out=process.argv[process.argv.indexOf('--out')+1];
if(!process.argv.includes('--out')||!path.isAbsolute(out??'')||fs.existsSync(out))throw Error('Require a new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-natural-host-'));
const owner='100001',bot='100002',token=randomBytes(24).toString('hex'),sends=[];
const report={at:new Date().toISOString(),boundary:'Real isolated OpenClaw hooks, tools, domain storage, Cron and loopback QQ HTTP receipts. Deterministic cognition; no model provider or QQ network; no SMTP, production writes or production restart.',cases:[],requests:0};
let active,sequence=100,child;
const dbfile=path.join(root,'state/personal-reminders/reminders.sqlite');
function query(sql,...args){const db=new DatabaseSync(dbfile,{readOnly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}}
const rows=()=>query('SELECT proposal_id,payload_hash FROM confirmation_proposals ORDER BY created_at_utc,rowid');
const select=(i=-1)=>{const r=rows().at(i);assert(r);return{domain:'personal_reminder',proposalId:r.proposal_id,payloadHash:r.payload_hash};};
const commit=(i=-1)=>{const r=select(i);return{proposal_id:r.proposalId,payload_hash:r.payloadHash};};
function decode(value){for(let i=0;i<7;i++){if(typeof value==='string'){try{value=JSON.parse(value);continue;}catch{break;}}if(Array.isArray(value)&&value.length===1){value=value[0].text;continue;}if(value?.result){value=value.result;continue;}if(value?.content?.length===1){value=value.content[0].text;continue;}break;}return value;}
const model=http.createServer(async(req,res)=>{
 try{
  assert(active);assert(++report.requests<=70,'request budget');
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
  // Model fixture transcripts are synthetic, retained only on a failed local fixture.
  fs.appendFileSync(path.join(root,'model-fixture.jsonl'),JSON.stringify(body)+'\n',{mode:0o600});
  const all=JSON.stringify(body.messages);assert(all.includes('KURUMI_CONFIRMATION_CURRENT_USER'),'missing trusted current user prompt');
  assert(all.includes('不要求用户抄确认码'),'missing authorized confirmation rules');
  const last=body.messages.findLast(m=>m.role==='tool');
  if(active.expected){const result=decode(last?.content);assert.equal(result.ok,active.expected.ok,JSON.stringify(result));if(active.expected.code)assert.equal(result.code,active.expected.code);active.expected=undefined;}
  const step=active.steps[active.next];let tool;
  if(step){if(!active.discovered){tool=['tool_search',{query:step[0],limit:1}];active.discovered=true;}
   else{tool=['tool_call',{id:step[0],args:typeof step[1]==='function'?step[1]():step[1]}];active.expected=step[2];active.next++;active.discovered=false;}}
  const message=tool?{role:'assistant',content:null,tool_calls:[{id:'call_'+report.requests,type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]}:{role:'assistant',content:'MODEL_PARAPHRASE_MUST_BE_REPLACED'};
  const usage={prompt_tokens:1,completion_tokens:1,total_tokens:2};res.setHeader('content-type',body.stream?'text/event-stream':'application/json');
  if(body.stream){const base={id:'chatcmpl-natural',object:'chat.completion.chunk',created:1,model:'fixture'};
   res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{...message,...(tool?{tool_calls:message.tool_calls.map((c,index)=>({...c,index}))}:{})},finish_reason:null}]})+'\n\n');
   res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage})+'\n\n');res.end('data: [DONE]\n\n');
  }else res.end(JSON.stringify({id:'chatcmpl-natural',object:'chat.completion',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage}));
 }catch(error){report.modelError=error.message;console.error('FIXTURE_MODEL_ERROR',error.message);res.writeHead(400);res.end(JSON.stringify({error:{message:'isolated_confirmation_fixture_failed'}}));}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const onebot=http.createServer(async(req,res)=>{
 assert.equal(req.headers.authorization,'Bearer '+token);let raw='';for await(const c of req)raw+=c;
 let data=req.url==='/get_login_info'?{user_id:Number(bot)}:{};
 if(req.url==='/send_private_msg'){const args=JSON.parse(raw);assert.equal(String(args.user_id),owner);sends.push(args);data={message_id:20000+sends.length};}
 res.end(JSON.stringify({status:'ok',retcode:0,data}));
});
await new Promise(r=>onebot.listen(0,'127.0.0.1',r));const ws=new WebSocketServer({server:onebot});
const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
for(const dir of ['workspace','channel','media'])fs.mkdirSync(path.join(root,dir));
fs.writeFileSync(path.join(root,'workspace/AGENTS.md'),'Use the registered typed business tools.');
for(const file of ['http-token','ws-token'])fs.writeFileSync(path.join(root,file),token,{mode:0o600});
const ids=['kurumi-qq','personal-reminders','personal-confirmation'];
const tools=['personal_confirmation','personal_reminder_propose','personal_reminder_commit'];
const cfg=compileAccessConfig({
 gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},
 models:{providers:{fixture:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'synthetic',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:1200,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},
 agents:{ownership:'explicit',defaults:{workspace:path.join(root,'workspace'),systemAgent:{agentId:'main'},model:{primary:'fixture/fixture'},heartbeat:{every:'0m'}},entries:{main:{workspace:path.join(root,'workspace'),model:{primary:'fixture/fixture'},tools:{profile:'full',allow:tools,deny:['read','write','edit','exec','process','message','sessions_spawn']}}}},
 channels:{'kurumi-qq':{enabled:true,httpUrl:`http://127.0.0.1:${onebot.address().port}`,wsUrl:`ws://127.0.0.1:${onebot.address().port}`,httpTokenFile:path.join(root,'http-token'),wsTokenFile:path.join(root,'ws-token'),stateDir:path.join(root,'channel'),mediaRoot:path.join(root,'media'),testIngress:true,dailySendLimit:100,segmentDelayMs:0}},
 plugins:{allow:ids,load:{paths:ids.map(id=>path.join(repo,'chatbot/plugins',id))},entries:Object.fromEntries(ids.map(id=>[id,{enabled:true,...(id==='personal-confirmation'?{hooks:{allowConversationAccess:true}}:{}),...(id==='personal-reminders'?{config:{reminderBackend:'native-service',reminderRunnerRoot:path.join(repo,'chatbot/plugins/personal-reminders')}}:{})}])),slots:{memory:'none'}},
 session:{dmScope:'per-channel-peer'},cron:{enabled:false},logging:{file:path.join(root,'runtime.log')},tools:{deny:['exec','process','message','sessions_spawn'],web:{search:{enabled:false},fetch:{enabled:false}}},
},ownerPolicy(owner));
fs.writeFileSync(path.join(root,'openclaw.json'),JSON.stringify(cfg),{mode:0o600});
const fd=fs.openSync(path.join(root,'gateway.log'),'w',0o600);
child=spawn(process.execPath,[path.join(repo,'node_modules/openclaw/openclaw.mjs'),'gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:path.join(root,'openclaw.json'),OPENCLAW_AGENT_DIR:path.join(root,'agents/main/agent')}});fs.closeSync(fd);
const call=(method,params={},timeout=60000)=>callGatewayFromCli(method,{url:`ws://127.0.0.1:${port}`,token,timeout:String(timeout),json:true},params);
async function turn(label,text,steps,verify){active={label,steps,next:0,discovered:false};const start=sends.length;
 const result=await call('kurumi-qq.testInbound',{event:{post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(owner),message_id:++sequence,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]}});
 assert(!report.modelError,report.modelError);assert(result.ok);assert.equal(active.next,steps.length);assert(!active.expected,'last tool result was not observed');await verify?.(sends.slice(start));report.cases.push({label,passed:true,toolCalls:steps.length,receiptCount:sends.length-start});console.log(JSON.stringify({case:label,passed:true}));}
const propose=content=>['personal_reminder_propose',{schema_version:1,request:{kind:'reminder.create',content,schedule:{timezone:'Asia/Shanghai',local_date_time:'2026-11-30T20:00'}}},{ok:true}];
const confirmation=(expected={ok:true},i=-1)=>['personal_confirmation',()=>({action:'confirm',...select(i)}),expected];
try{
 let ready=false;for(let n=0;n<100;n++){try{await call('health',{},1000);ready=true;break;}catch{if(child.exitCode!==null)throw Error('isolated gateway exited');await new Promise(r=>setTimeout(r,300));}}assert(ready,'isolated gateway readiness');
 await turn('same-message-cannot-confirm','生成一个测试提醒并直接确认',[propose('宿主测试甲'),confirmation({ok:false,code:'proposal_not_presented'})],sent=>{
  assert(sent.length>0);assert(!JSON.stringify(sent).includes('MODEL_PARAPHRASE'));assert(query('SELECT presented_at_utc FROM confirmation_previews')[0].presented_at_utc);assert.equal(query('SELECT * FROM approval_grants').length,0);
 });
 await turn('next-message-bare-confirm-commits','确认',[
  ['personal_confirmation',{action:'list',domain:'personal_reminder'},{ok:true}],confirmation(),['personal_reminder_commit',()=>commit(),{ok:true}],
 ],()=>{assert.equal(query("SELECT * FROM confirmation_proposals WHERE status='committed'").length,1);assert.equal(query('SELECT * FROM approval_grants WHERE consumed_at_utc IS NOT NULL').length,1);});
 await turn('two-previews-in-one-batch','再生成两个测试提醒',[propose('宿主测试乙'),propose('宿主测试丙')],sent=>{assert(JSON.stringify(sent).includes('宿主测试乙'));assert(JSON.stringify(sent).includes('宿主测试丙'));});
 await turn('ambiguous-bare-confirm-rejected','确认',[confirmation({ok:false,code:'confirmation_target_ambiguous'})]);
 await turn('explicit-reference-confirms-one','确认宿主测试丙那条',[confirmation(),['personal_reminder_commit',()=>commit(),{ok:true}]],()=>{assert.equal(query("SELECT * FROM confirmation_proposals WHERE status='committed'").length,2);});
 await turn('negative-does-not-authorize','先别执行，我不确认',[confirmation({ok:false,code:'confirmation_not_explicit'},1)]);
 await turn('change-needs-new-preview','确认，不过改成九点',[confirmation({ok:false,code:'confirmation_not_explicit'},1)]);
 assert.equal(query('SELECT * FROM approval_grants').length,2);report.passed=true;
}catch(error){report.passed=false;report.error=error.message;report.diagnosticsRoot=root;process.exitCode=1;}
finally{
 if(child.exitCode===null){child.kill('SIGTERM');let timer;await Promise.race([once(child,'exit'),new Promise(r=>{timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}r();},10000);})]);clearTimeout(timer);}
 for(const client of ws.clients)client.terminate();await new Promise(r=>ws.close(r));onebot.closeAllConnections();model.closeAllConnections();await Promise.all([new Promise(r=>onebot.close(r)),new Promise(r=>model.close(r))]);
 report.childStopped=child.exitCode!==null||child.signalCode!==null;report.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 if(report.passed)fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,requests:report.requests,error:report.error,evidence:out}));
}
