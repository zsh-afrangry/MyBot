// Real isolated Gateway, model/session composition, fixed native Cron commands and
// loopback QQ receipts. Deterministic cognition and a synthetic domain clock only.
// No real model/API/QQ/SMTP, production database writes or service restart. docs/21.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import net from 'node:net';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {randomBytes} from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';import {WebSocketServer} from 'ws';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {compileAccessConfig} from '../../packages/access-control/config.js';import {ownerPolicy} from '../access-control/fixtures.mjs';
import {seedList,seedReminder} from './fixtures.mjs';import {ListStore} from '../../plugins/personal-reminder-list/store.js';
const out=process.argv[process.argv.indexOf('--out')+1];if(!process.argv.includes('--out')||!path.isAbsolute(out??'')||fs.existsSync(out))throw Error('Require a new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-expression-host-'));
const owner='100001',bot='100002',token=randomBytes(24).toString('hex'),sessionKey='agent:main:kurumi-qq:direct:'+owner;
const report={at:new Date().toISOString(),boundary:'Real isolated OpenClaw session/plugin/Cron execution and loopback QQ receipts; deterministic local model and synthetic domain clock. No external API, no model provider, no QQ network, no SMTP or production writes.',cases:[],requests:0};
const creation=()=>Date.parse('2026-11-30T19:55:00+08:00'),due=Date.parse('2026-11-30T20:00:05+08:00');
seedList(root,owner,creation);const ids=[await seedReminder(root,owner,creation),await seedReminder(root,owner,creation)];
const ls=new ListStore({root,ownerId:owner,now:creation});ls.changeSchedule({action:'schedule',times:['19:59','20:00']},{});ls.close();
const sends=[],model=http.createServer(async(req,res)=>{try{let raw='';for await(const x of req)raw+=x;const body=JSON.parse(raw);assert(++report.requests<=20);
 assert(JSON.stringify(body.messages).includes('KURUMI_NOTICE_PERSONA'),'bound persona missing');
 const text=report.requests===1?'模型初始对话':'模型自然提醒，请核对附带事实。';
 if(report.requests>1)assert(JSON.stringify(body.messages).includes('合成近期对话'),'recent bound chat missing');
 res.writeHead(200,{'content-type':'text/event-stream'});const base={id:'notice-'+report.requests,object:'chat.completion.chunk',created:1,model:'fixture'};
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\n');
 res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');
}catch(error){report.modelError=error.message;res.writeHead(500);res.end('fixture_model_failed');}});await new Promise(r=>model.listen(0,'127.0.0.1',r));
const onebot=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);let raw='';for await(const x of req)raw+=x;
 let data=req.url==='/get_login_info'?{user_id:Number(bot)}:{};
 if(req.url==='/send_private_msg'){const args=JSON.parse(raw);assert.equal(String(args.user_id),owner);sends.push(args);data={message_id:20000+sends.length};}
 res.end(JSON.stringify({status:'ok',retcode:0,data}));
});await new Promise(r=>onebot.listen(0,'127.0.0.1',r));const ws=new WebSocketServer({server:onebot});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const probe=path.join(root,'probe');fs.mkdirSync(probe);for(const d of ['workspace','channel','media'])fs.mkdirSync(path.join(root,d));
fs.writeFileSync(path.join(root,'workspace/AGENTS.md'),'KURUMI_NOTICE_PERSONA: Use the current private conversation to express a business notice, not to start another operation.');
for(const name of ['http-token','ws-token'])fs.writeFileSync(path.join(root,name),token,{mode:0o600});
fs.writeFileSync(path.join(probe,'package.json'),JSON.stringify({name:'notice-probe',type:'module',openclaw:{extensions:['./index.js']}}));
fs.writeFileSync(path.join(probe,'openclaw.plugin.json'),JSON.stringify({id:'notice-probe',activation:{onStartup:true},configSchema:{type:'object',properties:{}}}));
const url=name=>JSON.stringify(pathToFileURL(path.join(repo,name)).href);
fs.writeFileSync(path.join(probe,'index.js'),`import {registerDigestNotice} from ${url('chatbot/plugins/personal-reminder-list/notification.js')};
import {ListStore} from ${url('chatbot/plugins/personal-reminder-list/store.js')};
import {registerReminderNotice} from ${url('chatbot/packages/personal-domains/dist/reminder-notification.js')};
import {ReminderStore} from ${url('chatbot/packages/personal-domains/dist/reminder-store.js')};
export default {id:'notice-probe',register(api){
 registerDigestNotice(api,{root:${JSON.stringify(root)},ownerId:${JSON.stringify(owner)},openStore:o=>new ListStore(o)},{now:()=>${due}});
 registerReminderNotice(api,{open:()=>new ReminderStore({stateDirectory:${JSON.stringify(root+'/state/personal-reminders')},now:()=>${Math.floor(due/1000)}})});
}};`);
const cfg=compileAccessConfig({gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},
 models:{providers:{fixture:{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',apiKey:'synthetic',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:1000}]}}},
 agents:{ownership:'explicit',defaults:{workspace:root+'/workspace',systemAgent:{agentId:'main'},model:{primary:'fixture/fixture'},heartbeat:{every:'0m'}},entries:{main:{workspace:root+'/workspace',model:{primary:'fixture/fixture'},tools:{deny:['read','write','edit','exec','process','message','sessions_spawn'],allow:[]}}}},
 channels:{'kurumi-qq':{enabled:true,httpUrl:'http://127.0.0.1:'+onebot.address().port,wsUrl:'ws://127.0.0.1:'+onebot.address().port,httpTokenFile:root+'/http-token',wsTokenFile:root+'/ws-token',stateDir:root+'/channel',mediaRoot:root+'/media',testIngress:true,dailySendLimit:20,segmentDelayMs:0}},
 plugins:{allow:['kurumi-qq','notice-probe'],load:{paths:[repo+'/chatbot/plugins/kurumi-qq',probe]},entries:{'kurumi-qq':{enabled:true},'notice-probe':{enabled:true}},slots:{memory:'none'}},
 session:{dmScope:'per-channel-peer'},cron:{enabled:true},tools:{codeMode:false,web:{search:{enabled:false},fetch:{enabled:false}}},logging:{file:root+'/runtime.log'}},ownerPolicy(owner));
fs.writeFileSync(root+'/openclaw.json',JSON.stringify(cfg),{mode:0o600});const fd=fs.openSync(root+'/gateway.log','w',0o600);
const child=spawn(process.execPath,[repo+'/node_modules/openclaw/openclaw.mjs','gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:root+'/openclaw.json',OPENCLAW_AGENT_DIR:root+'/agents/main/agent'}});fs.closeSync(fd);
const call=(method,params={},timeout=65000)=>callGatewayFromCli(method,{url:'ws://127.0.0.1:'+port,token,timeout:String(timeout),json:true},params);
const pass=label=>{report.cases.push({label,passed:true});console.log(JSON.stringify({case:label,passed:true}));};
try{
 let ready=false;for(let n=0;n<100;n++){try{await call('health',{},1000);ready=true;break;}catch{if(child.exitCode!==null)throw Error('Gateway exited');await new Promise(r=>setTimeout(r,200));}}assert(ready);
 const init=await call('agent',{agentId:'main',sessionKey,message:'合成近期对话：稍后请按已有提醒通知我。',deliver:false,idempotencyKey:'notice-chat-init'});
 assert.equal((await call('agent.wait',{runId:init.runId,timeoutMs:30000})).status,'ok');pass('existing-chat-persona-and-history');
 const list=await call('personal-reminder-list.compose',{slot:'19:59'});for(const value of ['模型自然提醒','合成事项','明细不能丢','越快越好'])assert(list.text.includes(value));
 assert.deepEqual(await call('personal-reminder-list.compose',{slot:'19:59'}),{});pass('bound-list-composition-and-deduplication');
 const reminder=await call('personal-reminder.compose',{id:ids[0]});assert(reminder.text.includes('合成提醒：起身活动'));assert(reminder.text.includes('2026-11-30 20:00'));assert.deepEqual(await call('personal-reminder.compose',{id:ids[0]}),{});pass('bound-one-off-composition-and-deduplication');
 await assert.rejects(call('personal-reminder.compose',{id:ids[0],to:'user:other'}));pass('runner-cannot-select-recipient');
 const attachment=await call('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(owner),message_id:201,time:Math.floor(Date.now()/1000),message:[{type:'file',data:{name:'synthetic.md',file_id:'not-a-pdf'}}]}});
 assert(attachment.attachmentReply&&attachment.modelDispatched);assert(attachment.captured.some(p=>p.text?.includes('模型自然提醒')));assert(attachment.captured.every(p=>!p.mediaUrl));pass('unsupported-attachment-model-notice-without-old-artifact');
 const cron=[];for(const [name,argv,cwd] of [['list',[process.execPath,repo+'/chatbot/scripts/reminder-list.mjs','run','--slot','20:00'],repo+'/chatbot'],['reminder',[process.execPath,'dist/reminder-cli.js','deliver','--id',ids[1]],repo+'/chatbot/packages/personal-domains']]){
  const job=await call('cron.add',{name:'fixture-'+name,enabled:true,schedule:{kind:'at',at:new Date(Date.now()+1500).toISOString()},sessionTarget:'isolated',wakeMode:'now',payload:{kind:'command',argv,cwd,env:{OPENCLAW_GATEWAY_PORT:String(port)},timeoutSeconds:75,noOutputTimeoutSeconds:70,outputMaxBytes:524288},delivery:{mode:'announce',channel:'kurumi-qq',to:'user:'+owner,accountId:'default'},deleteAfterRun:false});cron.push({name,id:job.id??job.jobId});
 }
 for(const job of cron){let run;for(let n=0;n<120;n++){run=(await call('cron.runs',{id:job.id,limit:1},5000)).entries?.[0];if(run)break;await new Promise(r=>setTimeout(r,500));}assert.equal(run?.status,'ok',JSON.stringify(run));assert.equal(run.delivered,true,JSON.stringify(run));pass('native-fixed-'+job.name+'-command-and-qq-receipt');}
 assert(sends.some(s=>JSON.stringify(s).includes('明细不能丢')));assert(sends.some(s=>JSON.stringify(s).includes('起身活动')));report.platformAccepted=sends.length;report.passed=true;
}catch(error){report.passed=false;report.error=error.message;report.diagnosticsRoot=root;process.exitCode=1;}
finally{try{process.kill(-child.pid,'SIGTERM');}catch{}if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}for(const client of ws.clients)client.terminate();await new Promise(r=>ws.close(r));onebot.closeAllConnections();model.closeAllConnections();await Promise.all([new Promise(r=>onebot.close(r)),new Promise(r=>model.close(r))]);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});if(report.passed)fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,requests:report.requests,out,error:report.error}));}
