// Executed ONLY within a private Bubblewrap mount/network/PID namespace by restore-verify.
// No production directory, host bus, or network interface is mounted into this process.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const [target]=process.argv.slice(2),runtime=target+'/runtime',repo=target+'/repos/kurumi-fusion',sdk=target+'/sdk/openclaw';
assert(!fs.existsSync('/home/afrangry/.openclaw-fusion'),'Production state must be invisible');
assert(!fs.existsSync('/home/afrangry/kurumi-fusion'),'Production source must be invisible');
assert(!fs.existsSync('/run/user'),'Host service bus must be invisible');
assert(!fs.existsSync('/sys/class/net'),'Host network topology must be invisible');
const cfg=JSON.parse(fs.readFileSync(runtime+'/openclaw.json'));
const req=createRequire(repo+'/chatbot/plugins/kurumi-qq/index.js');
assert(req.resolve('ws').startsWith(target+'/'));
assert(req.resolve('openclaw/plugin-sdk/media-runtime').startsWith(target+'/'));
process.env.OPENCLAW_STATE_DIR=runtime;process.env.OPENCLAW_CONFIG_PATH=runtime+'/openclaw.json';
process.env.OPENCLAW_AGENT_DIR=runtime+'/agents/main/agent';
Object.assign(process.env,JSON.parse(fs.readFileSync(runtime+'/runtime-env.json')));
const loaded=[];
for(const dir of cfg.plugins.load.paths){
 const manifest=JSON.parse(fs.readFileSync(dir+'/package.json'));
 for(const entry of manifest.openclaw?.runtimeExtensions??manifest.openclaw?.extensions??[]){await import('file://'+path.resolve(dir,entry));loaded.push(manifest.name);}
}
assert(loaded.length>=7,'All configured plugins must import');
// In-namespace OneBot fixture: no access to the real host loopback interface.
const {WebSocketServer}=req('ws');
const sends=[];
const server=http.createServer(async(request,response)=>{
 let body='';for await(const c of request)body+=c;
 const action=request.url.slice(1);let data;
 if(action==='get_login_info')data={user_id:1794511189,nickname:'isolated-fixture'};
 else if(action==='get_status')data={online:true,good:true};
 else if(action==='send_private_msg'){const p=JSON.parse(body);assert.equal(String(p.user_id),cfg.channels['kurumi-qq'].ownerId);sends.push(p);data={message_id:8000+sends.length};}
 else {response.writeHead(400);response.end();return;}
 response.setHeader('content-type','application/json');response.end(JSON.stringify({status:'ok',retcode:0,data}));
});
await new Promise(resolve=>server.listen(19083,'127.0.0.1',resolve));
const ws=new WebSocketServer({host:'127.0.0.1',port:19084});
cfg.channels['kurumi-qq'].enabled=true;
cfg.channels['kurumi-qq'].httpUrl='http://127.0.0.1:19083';cfg.channels['kurumi-qq'].wsUrl='ws://127.0.0.1:19084';
fs.writeFileSync(runtime+'/openclaw.json',JSON.stringify(cfg,null,2),{mode:0o600});
const out=fs.openSync(target+'/gateway-probe.log','a',0o600);
const child=spawn(process.execPath,[sdk+'/openclaw.mjs','gateway','run','--port','18891','--bind','loopback','--auth','token','--tailscale','off'],{env:process.env,stdio:['ignore',out,out]});
let exited=false;const done=new Promise(resolve=>child.on('exit',code=>{exited=true;resolve(code);}));
try{
 const {callGatewayFromCli}=await import('file://'+sdk+'/dist/plugin-sdk/gateway-runtime.js').catch(()=>import(req.resolve('openclaw/plugin-sdk/gateway-runtime')));
 let health;
 for(let i=0;i<70;i++){
  if(exited)throw Error('Isolated Gateway exited; inspect private gateway-probe.log');
  try{health=await callGatewayFromCli('health',{url:'ws://127.0.0.1:18891',token:process.env.OPENCLAW_GATEWAY_TOKEN,timeout:'1500',json:true},{});break;}catch{await delay(700);}
 }
 assert(health,'Isolated Gateway did not become healthy');
 // The namespace is the hard boundary; disabled channels and cron also prevent accidental activity.
 assert.equal(cfg.cron.enabled,false);
 const {sendPayload}=await import('file://'+repo+'/chatbot/plugins/kurumi-qq/src/transport.js');
 await sendPayload({cfg,to:'user:'+cfg.channels['kurumi-qq'].ownerId,text:'isolated recovery transport check',key:'recovery-'+Date.now()});
 assert.equal(sends.length,1);
 const image=runtime+'/media/recovery-fixture.png';fs.mkdirSync(path.dirname(image),{recursive:true});
 fs.writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=','base64'));
 const {stageImage}=await import('file://'+repo+'/chatbot/plugins/kurumi-qq/src/media.js');
 const media=await stageImage({data:{file:image}},cfg.channels['kurumi-qq']);assert(media.contentType.startsWith('image/'));assert(media.path.startsWith(runtime+'/'));
 await sendPayload({cfg,to:'user:'+cfg.channels['kurumi-qq'].ownerId,text:'',mediaUrl:image,key:'recovery-image-'+Date.now()});assert.equal(sends.length,2);
 const status=await callGatewayFromCli('channels.status',{url:'ws://127.0.0.1:18891',token:process.env.OPENCLAW_GATEWAY_TOKEN,timeout:'3000',json:true},{});
 assert(status.channelAccounts['kurumi-qq'][0].connected,'Restored channel must connect to isolated OneBot');
 const {projectCatalog}=await import('file://'+repo+'/chatbot/plugins/kurumi-tasks/projects.js');
 const {runSandbox}=await import('file://'+repo+'/chatbot/plugins/kurumi-tasks/sandbox.js');
 let projectChecks=0;
 for(const project of projectCatalog(cfg))for(const check of project.checks){
  const result=await runSandbox(project,check.argv,{timeoutMs:check.timeoutMs});
  assert.equal(result.code,0,'Restored project check failed: '+result.output.slice(-1500));projectChecks++;
 }

 fs.writeFileSync(target+'/isolation-result.json',JSON.stringify({ok:true,loaded,productionInvisible:true,hostBusInvisible:true,networkNamespace:true,gatewayHealth:true,mockOneBotDelivery:2,imageStaging:true,projectChecks,realDelivery:false,cronEnabled:false},null,2));
 console.log('Isolated Gateway health and all plugin imports passed; production paths and network inaccessible');
}finally{
 if(!exited)child.kill('SIGTERM');
 await Promise.race([done,delay(10000)]);
 if(!exited){child.kill('SIGKILL');await done;}
 fs.closeSync(out);
 for(const client of ws.clients)client.terminate();await new Promise(resolve=>ws.close(resolve));await new Promise(resolve=>server.close(resolve));
 cfg.channels['kurumi-qq'].enabled=false;fs.writeFileSync(runtime+'/openclaw.json',JSON.stringify(cfg,null,2),{mode:0o600});
}
