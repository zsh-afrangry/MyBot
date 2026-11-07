// docs/9: real isolated OpenClaw reply-mode/tag processing and local OneBot receipts.
// Deterministic local model, synthetic messages. No QQ network, provider or production writes.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import net from 'node:net';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {randomBytes} from 'node:crypto';import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';import {WebSocketServer} from 'ws';import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {compileAccessConfig} from '../../packages/access-control/config.js';import {ownerPolicy} from '../access-control/fixtures.mjs';
const out=process.argv[process.argv.indexOf('--out')+1];if(!process.argv.includes('--out')||!path.isAbsolute(out??'')||fs.existsSync(out))throw Error('Require a new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-threading-host-'));
const owner='100001',bot='100002',token=randomBytes(24).toString('hex'),sends=[];
const report={at:new Date().toISOString(),boundary:'Real isolated Gateway, native replyToMode/tag processing and loopback OneBot receipts. Synthetic owner and deterministic local model; no external model/API/QQ or production writes.',cases:[],requests:0};
let answer='';
const model=http.createServer(async(req,res)=>{try{let raw='';for await(const x of req)raw+=x;const body=JSON.parse(raw);assert(++report.requests<=8);
 assert(body.stream);res.writeHead(200,{'content-type':'text/event-stream'});const base={id:'thread-'+report.requests,object:'chat.completion.chunk',created:1,model:'fixture'};
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]})+'\n\n');
 res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');
}catch(error){report.modelError=error.message;res.writeHead(500);res.end('fixture_failed');}});await new Promise(r=>model.listen(0,'127.0.0.1',r));
const onebot=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);let raw='';for await(const x of req)raw+=x;
 let data=req.url==='/get_login_info'?{user_id:Number(bot)}:{};
 if(req.url==='/send_private_msg'){const args=JSON.parse(raw);assert.equal(String(args.user_id),owner);sends.push(args);data={message_id:20000+sends.length};}
 res.end(JSON.stringify({status:'ok',retcode:0,data}));
});await new Promise(r=>onebot.listen(0,'127.0.0.1',r));const ws=new WebSocketServer({server:onebot});
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
for(const d of ['workspace','channel','media'])fs.mkdirSync(path.join(root,d));for(const name of ['http-token','ws-token'])fs.writeFileSync(path.join(root,name),token,{mode:0o600});
fs.writeFileSync(root+'/workspace/AGENTS.md','Use natural Chinese. Ordinary messages do not need a reply tag.');
const cfg=compileAccessConfig({gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},
 models:{providers:{fixture:{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',apiKey:'synthetic',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:1600}]}}},
 agents:{ownership:'explicit',defaults:{workspace:root+'/workspace',systemAgent:{agentId:'main'},model:{primary:'fixture/fixture'},heartbeat:{every:'0m'}},entries:{main:{workspace:root+'/workspace',model:{primary:'fixture/fixture'},tools:{allow:[],deny:['read','write','edit','exec','process','message','sessions_spawn']}}}},
 channels:{'kurumi-qq':{enabled:true,replyToMode:'off',httpUrl:'http://127.0.0.1:'+onebot.address().port,wsUrl:'ws://127.0.0.1:'+onebot.address().port,httpTokenFile:root+'/http-token',wsTokenFile:root+'/ws-token',stateDir:root+'/channel',mediaRoot:root+'/media',testIngress:true,dailySendLimit:50,chunkLimit:100,naturalSegments:false,segmentDelayMs:0}},
 plugins:{allow:['kurumi-qq'],load:{paths:[repo+'/chatbot/plugins/kurumi-qq']},entries:{'kurumi-qq':{enabled:true}},slots:{memory:'none'}},
 session:{dmScope:'per-channel-peer'},cron:{enabled:false},tools:{codeMode:false,web:{search:{enabled:false},fetch:{enabled:false}}},logging:{file:root+'/runtime.log'}},ownerPolicy(owner));
fs.writeFileSync(root+'/openclaw.json',JSON.stringify(cfg),{mode:0o600});const fd=fs.openSync(root+'/gateway.log','w',0o600);
const child=spawn(process.execPath,[repo+'/node_modules/openclaw/openclaw.mjs','gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:root+'/openclaw.json',OPENCLAW_AGENT_DIR:root+'/agents/main/agent'}});fs.closeSync(fd);
const call=(method,params={},timeout=50000)=>callGatewayFromCli(method,{url:'ws://127.0.0.1:'+port,token,timeout:String(timeout),json:true},params);
let sequence=200;const inbound=(patch={})=>({post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(owner),message_id:++sequence,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'合成引用策略测试'}}],...patch});
const pass=(label,rows)=>{report.cases.push({label,passed:true,receipts:rows.length,replyIds:rows.flatMap(r=>r.message.filter(s=>s.type==='reply').map(s=>s.data.id))});console.log(JSON.stringify({case:label,passed:true}));};
async function turn(label,text,verify){answer=text;const start=sends.length;const result=await call('kurumi-qq.testInbound',{event:inbound()});assert(result.ok);assert(!report.modelError,report.modelError);const rows=sends.slice(start);assert(rows.length);assert(!JSON.stringify(rows).includes('[[reply_to'));verify(rows);pass(label,rows);}
try{
 let ready=false;for(let n=0;n<100;n++){try{await call('health',{},1000);ready=true;break;}catch{if(child.exitCode!==null)throw Error('Gateway exited');await new Promise(r=>setTimeout(r,200));}}assert(ready);
 await turn('ordinary-off-has-no-implicit-current-quote','普通回复。',rows=>assert(rows.every(r=>r.message.every(s=>s.type!=='reply'))));
 await turn('explicit-earlier-reference-preserved','[[reply_to:201]]针对较早的问题作答。',rows=>assert.equal(rows[0].message[0].data.id,'201'));
 const current=String(sequence+1);await turn('explicit-current-directive-still-supported','[[reply_to_current]]这次明确引用当前问题。',rows=>assert.equal(rows[0].message[0].data.id,current));
 await turn('segmented-explicit-quote-only-on-first-part','[[reply_to:201]]'+('较长的合成答复内容。'.repeat(40)),rows=>{assert(rows.length>1);assert.equal(rows[0].message[0].type,'reply');assert(rows.slice(1).every(r=>r.message.every(s=>s.type!=='reply')));});
 const before=sends.length,requests=report.requests;for(const patch of [{message_type:'group'},{user_id:100009}])assert((await call('kurumi-qq.testInbound',{event:inbound(patch)})).ignored);
 assert.equal(sends.length,before);assert.equal(report.requests,requests);pass('quote-policy-does-not-open-group-or-stranger',[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.message;report.diagnosticsRoot=root;process.exitCode=1;}
finally{
 if(child.exitCode===null){child.kill('SIGTERM');let timer;await Promise.race([once(child,'exit'),new Promise(r=>{timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}r();},10000);})]);clearTimeout(timer);}
 for(const client of ws.clients)client.terminate();await new Promise(r=>ws.close(r));onebot.closeAllConnections();model.closeAllConnections();await Promise.all([new Promise(r=>onebot.close(r)),new Promise(r=>model.close(r))]);
 report.childStopped=child.exitCode!==null||child.signalCode!==null;report.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});if(report.passed)fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,requests:report.requests,error:report.error,evidence:out}));
}
