// Authorized real OpenClaw + main-model acceptance. Mock translation worker and OneBot only.
// Separate /tmp runtime; no real translation API request, QQ/mail delivery or production write.
// Development owner: docs/22; evidence: docs/verification/paper-translation-2026-10-17/ (explicit --out).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {Documents} from '../../packages/documents/index.js';
import {pdf} from './fixtures.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const outArg=process.argv.indexOf('--out');
const out=outArg<0?path.join(repo,'docs/verification/paper-translation-2026-10-17/host.json'):process.argv[outArg+1];
if(!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Use an absolute, new --out evidence file');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-paper-host-'));
const runtime='/home/afrangry/.openclaw-fusion',owner='365999865',bot='1794511189',token=randomBytes(24).toString('hex');
const report={at:new Date().toISOString(),boundary:'Real OpenClaw and configured main model; actual PDF tools and job service, fixture translator and mock OneBot; isolated /tmp state. No real translation API request, QQ/mail delivery or production write.',cases:[]};
const docs=new Documents(path.join(root,'documents'));
const document=await docs.add(pdf('Fixture input, not a real translated paper.'),{filename:'验收论文.pdf'},{inspect:async()=>({pages:1})});
const uploads=[];
const server=http.createServer(async(req,res)=>{
 if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
 let raw='';for await(const chunk of req)raw+=chunk;
 const args=raw?JSON.parse(raw):{};
 let data=req.url==='/get_login_info'?{user_id:Number(bot)}:req.url==='/get_status'?{online:true,good:true}:{};
 if(req.url==='/upload_private_file'){assert.equal(args.user_id,Number(owner));assert(fs.existsSync(args.file));uploads.push({name:args.name});data={file_id:'fixture-upload-'+uploads.length};}
 if(req.url==='/send_private_msg')data={message_id:9000};
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');const ws=new WebSocketServer({server});
const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
const fixture=path.join(root,'paper-plugin');fs.mkdirSync(fixture);
fs.copyFileSync(path.join(repo,'chatbot/plugins/kurumi-papers/openclaw.plugin.json'),path.join(fixture,'openclaw.plugin.json'));
fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'kurumi-papers',type:'module',openclaw:{extensions:['./index.js']}}));
fs.writeFileSync(path.join(fixture,'index.js'),`import fs from 'node:fs';import path from 'node:path';
import {createPaperPlugin} from ${JSON.stringify(pathToFileURL(path.join(repo,'chatbot/plugins/kurumi-papers/index.js')).href)};
import {PaperService} from ${JSON.stringify(pathToFileURL(path.join(repo,'chatbot/plugins/kurumi-papers/service.js')).href)};
import {pdf} from ${JSON.stringify(pathToFileURL(path.join(repo,'chatbot/tests/papers/fixtures.mjs')).href)};
export default createPaperPlugin({serviceFactory:(config,deps)=>new PaperService(config,{...deps,runner:async({work,outputKind})=>{const result={usage:{requests:0,fixture:true}};for(const kind of outputKind==='both'?['dual','mono']:[outputKind]){result[kind]=path.join(work,kind+'.pdf');fs.writeFileSync(result[kind],pdf('Fixture '+kind+' output, not a real translation.'));}return result;}})});
`);
const cfg=JSON.parse(fs.readFileSync(path.join(repo,'config/runtime.config.json')));delete cfg._managed;
cfg.gateway={mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}};
cfg.agents.defaults.workspace=path.join(root,'workspace');
cfg.agents.entries={main:{...cfg.agents.entries.main,workspace:path.join(root,'workspace'),tools:{profile:'messaging',alsoAllow:['kurumi_document','kurumi_translate','kurumi_document_send'],deny:['read','write','edit','exec','process','message','sessions_spawn','automations']}}};
cfg.plugins={allow:['kurumi-qq','kurumi-papers'],load:{paths:[path.join(repo,'chatbot/plugins/kurumi-qq'),fixture]},entries:{'kurumi-qq':{enabled:true},'kurumi-papers':{enabled:true,config:{root:docs.root,python:'/unused',credentialsFile:'/unused',liveTranslationEnabled:true}}},slots:{memory:'none'}};
cfg.tools={deny:cfg.tools.deny,fs:cfg.tools.fs,web:{search:{enabled:false},fetch:{enabled:false}}};
cfg.cron={enabled:false};cfg.logging.file=path.join(root,'runtime.log');
cfg.channels['kurumi-qq']={...cfg.channels['kurumi-qq'],httpUrl:`http://127.0.0.1:${server.address().port}`,wsUrl:`ws://127.0.0.1:${server.address().port}`,httpTokenFile:path.join(root,'http-token'),wsTokenFile:path.join(root,'ws-token'),stateDir:path.join(root,'channel'),mediaRoot:path.join(root,'media'),testIngress:true};
for(const dir of ['workspace','media','channel'])fs.mkdirSync(path.join(root,dir),{mode:0o700});
for(const file of ['http-token','ws-token'])fs.writeFileSync(path.join(root,file),token,{mode:0o600});
fs.writeFileSync(path.join(root,'openclaw.json'),JSON.stringify(cfg),{mode:0o600});
fs.copyFileSync(path.join(repo,'scripts/fusion/templates/AGENTS.md'),path.join(root,'workspace/AGENTS.md'));
fs.copyFileSync(path.join(repo,'roles/小鲸鱼.md'),path.join(root,'workspace/SOUL.md'));
const secrets=JSON.parse(fs.readFileSync(path.join(runtime,'runtime-env.json'))),fd=fs.openSync(path.join(root,'gateway.log'),'w',0o600);
const child=spawn(process.execPath,[path.join(repo,'node_modules/openclaw/openclaw.mjs'),'gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{cwd:repo,env:{...process.env,...secrets,OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:path.join(root,'openclaw.json'),OPENCLAW_AGENT_DIR:path.join(root,'agents/main/agent')},stdio:['ignore',fd,fd],detached:true});fs.closeSync(fd);
const {callGatewayFromCli}=await import('openclaw/plugin-sdk/gateway-runtime');
const call=(method,params={},timeout=180000)=>callGatewayFromCli(method,{url:`ws://127.0.0.1:${port}`,token,timeout:String(timeout),json:true},params);
let seq=0;
async function turn(label,text){
 const result=await call('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(owner),message_id:-200000-++seq,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]}});
 assert(result.ok);report.cases.push({label,result});return result;
}
try{
 let ready=false;for(let i=0;i<80;i++){try{await call('health',{},1000);ready=true;break;}catch{if(child.exitCode!==null)throw Error('Isolated Gateway exited');await new Promise(r=>setTimeout(r,500));}}
 assert(ready,'Isolated Gateway not ready');
 const listed=await turn('list-real-managed-id','帮我查一下已经收到的 PDF 文件，先不要翻译。');
 assert.match(JSON.stringify(listed.captured),/验收论文/);
 await turn('start-default-translation','把刚才那篇验收论文翻译成中文，用默认 GPT 翻译配置，不另外指定强度，只要一份中英对照的双语 PDF，直接发我 QQ。');
 let job;for(let i=0;i<80;i++){const names=fs.readdirSync(path.join(docs.root,'jobs'));job=names.length?JSON.parse(fs.readFileSync(path.join(docs.root,'jobs',names[0]))):null;if(job?.delivery?.status==='platform_accepted')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(job?.status,'succeeded');assert.equal(job.documentId,document.id);assert.equal(job.profile.model,'gpt-6.1-sol');assert.equal(job.profile.effort,'high');assert.equal(uploads.length,1);
  assert.equal(job.deliveryKind,'dual');assert.deepEqual(Object.keys(job.artifacts),['dual']);assert.match(uploads[0].name,/-dual\.pdf$/);
 report.job={documentId:job.documentId,profile:job.profile,status:job.status,delivery:job.delivery,usage:job.usage};
 await call('sessions.reset',{key:`agent:main:kurumi-qq:direct:${owner}`,reason:'new'});
 await turn('query-after-new-session','查一下我的论文翻译任务结果，现在不要重新翻译，也不要重新发送。');
 assert.equal(fs.readdirSync(path.join(docs.root,'jobs')).length,1);assert.equal(uploads.length,1);
 await turn('start-deepseek-official-defaults','请用 DeepSeek 官方接口把刚才那篇验收论文翻译成中文，双语 PDF。这次只生成，不要发 QQ 或邮件；未指定模型和强度，用 DeepSeek 翻译默认配置。');
 let deepseek;
 for(let i=0;i<80;i++){
  const jobs=fs.readdirSync(path.join(docs.root,'jobs')).map(name=>JSON.parse(fs.readFileSync(path.join(docs.root,'jobs',name))));
  deepseek=jobs.find(item=>item.id!==job.id);if(deepseek?.status==='succeeded')break;await new Promise(r=>setTimeout(r,100));
 }
 assert.equal(deepseek?.status,'succeeded');assert.equal(deepseek.documentId,document.id);
 assert.equal(deepseek.profile.provider,'deepseek');assert.equal(deepseek.profile.channel,'official');
 assert.equal(deepseek.profile.model,'deepseek-flash');assert.equal(deepseek.profile.effort,'high');
 assert.deepEqual(Object.keys(deepseek.artifacts),['dual']);
 assert.equal(deepseek.deliveryTarget,'none');assert.equal(uploads.length,1);
 report.deepseekJob={documentId:deepseek.documentId,profile:deepseek.profile,status:deepseek.status,delivery:deepseek.delivery,usage:deepseek.usage};
 report.passed=true;
}catch(error){report.passed=false;report.error=error.message;report.diagnosticsRoot=root;process.exitCode=1;}
finally{
 child.kill('SIGTERM');if(child.exitCode===null){let timer;await Promise.race([once(child,'exit'),new Promise(r=>timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}r();},35000))]);clearTimeout(timer);}
 for(const client of ws.clients)client.terminate();await new Promise(r=>ws.close(r));await new Promise(r=>server.close(r));
 report.childStopped=child.exitCode!==null||child.signalCode!==null;report.mockUploads=uploads;
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));
 if(report.passed)fs.rmSync(root,{recursive:true,force:true});
 console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,error:report.error,evidence:out}));
}
