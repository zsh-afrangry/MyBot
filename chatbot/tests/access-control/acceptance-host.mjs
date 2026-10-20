// Isolated real OpenClaw acceptance with local deterministic model/OneBot and injected PDF worker.
// Only temporary state and explicitly requested evidence file; no external model/API, real QQ/mail or production writes. docs/24 T04–T10.
// Evidence: docs/verification/access-control-2026-10-19/host.json via an explicit new --out file.
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
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {Documents} from '../../packages/documents/index.js';
import {ownerPolicy,memberRow,OWNER,MEMBER,OTHER} from './fixtures.mjs';
import {pdf} from '../papers/fixtures.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url)),arg=process.argv.indexOf('--out'),out=arg<0?null:process.argv[arg+1];
if(!out||!path.isAbsolute(out)||fs.existsSync(out))throw Error('Require an absolute new --out evidence file');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-access-host-')),token=randomBytes(24).toString('hex'),bot='900001';
const report={at:new Date().toISOString(),boundary:'Real isolated OpenClaw; local deterministic model/OneBot and fixture translator; temporary state only. No QQ network, no model provider, no production write.',cases:[]};
const uploads=[],modelChecks=[];
const model=http.createServer(async(req,res)=>{
 try{
 let raw='';for await(const x of req)raw+=x;const body=JSON.parse(raw),messages=body.messages??[];
 const userIndex=messages.findLastIndex(x=>x.role==='user'&&JSON.stringify(x.content).includes('ACL_CASE:'));
 const lastUser=messages[userIndex],user=typeof lastUser?.content==='string'?lastUser.content:JSON.stringify(lastUser?.content);
 const isMember=user?.includes('MEMBER_TEST');modelChecks.push({lastRole:messages.at(-1)?.role,member:isMember,ownerMemory:JSON.stringify(messages).includes('OWNER_PRIVATE_SENTINEL'),tools:(body.tools??[]).map(x=>x.function?.name)});
 const afterUser=messages.slice(userIndex+1),last=afterUser.findLast(x=>x.role==='tool'),match=/ACL_CASE:(list|translate|status|sensitive|import|research|background)\s*(\w+)?/.exec(user??'');let tool;
 const toolNameOf=m=>m?.name??afterUser.flatMap(x=>x.tool_calls??[]).find(x=>x.id===m?.tool_call_id)?.function?.name;
 const completed=last && !['tool_search','tool_describe'].includes(toolNameOf(last));
 if(!completed&&match){
 const op=match[1],value=match[2];
 tool=op==='list'?['kurumi_document',{action:'list'}]:op==='translate'?['kurumi_translate',{action:'start',documentId:value}]:op==='status'?['kurumi_translate',{action:'status',jobId:value}]:op==='import'?['kurumi_document',{action:'fetch',url:'https://arxiv.org/pdf/2609.00001'}]:op==='research'?['kurumi_task',{action:'start',kind:'research',task:'ACL_CASE:background'}]:op==='background'?['acl_background',{}]:['acl_sensitive',{}];
 }
 const available=(body.tools??[]).map(x=>x.function?.name);
 if(tool&&!available.includes(tool[0])&&available.includes('tool_search')){tool=afterUser.some(x=>x.role==='tool'&&toolNameOf(x)==='tool_search')?['tool_call',{id:tool[0],args:tool[1]}]:['tool_search',{query:tool[0],limit:1}];}
 const message=tool?{role:'assistant',content:null,tool_calls:[{id:'call_'+randomBytes(8).toString('hex'),type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]}:{role:'assistant',content:last?.role==='tool'?'ACL_RESULT '+(typeof last.content==='string'?last.content:JSON.stringify(last.content)):'ACL_OK'};
 res.setHeader('content-type',body.stream?'text/event-stream':'application/json');
 if(body.stream){const chunk={id:'chatcmpl-local',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:tool?{...message,tool_calls:message.tool_calls.map((x,index)=>({...x,index}))}:message,finish_reason:null}]};res.write('data: '+JSON.stringify(chunk)+'\n\n');res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\n');res.end('data: [DONE]\n\n');}
 else res.end(JSON.stringify({id:'chatcmpl-local',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
 }catch{res.writeHead(500);res.end();}
});model.listen(0,'127.0.0.1');await once(model,'listening');
const server=http.createServer(async(req,res)=>{
 if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
 let raw='';for await(const x of req)raw+=x;const args=JSON.parse(raw||'{}');let data={};
 if(req.url==='/get_login_info')data={user_id:Number(bot)};
 if(req.url==='/upload_private_file'){assert(fs.existsSync(args.file));uploads.push({qq:String(args.user_id),name:args.name});data={file_id:'synthetic-'+uploads.length};}
 if(req.url==='/send_private_msg')data={message_id:100};
 res.end(JSON.stringify({status:'ok',retcode:0,data}));
});server.listen(0,'127.0.0.1');await once(server,'listening');const ws=new WebSocketServer({server});
const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
const papers=path.join(root,'paper-plugin');fs.mkdirSync(papers);
fs.copyFileSync(path.join(repo,'chatbot/plugins/kurumi-papers/openclaw.plugin.json'),path.join(papers,'openclaw.plugin.json'));
fs.writeFileSync(path.join(papers,'package.json'),JSON.stringify({name:'kurumi-papers',type:'module',openclaw:{extensions:['./index.js']}}));
const url=rel=>JSON.stringify(pathToFileURL(path.join(repo,rel)).href);
fs.writeFileSync(path.join(papers,'index.js'),`import fs from 'node:fs';import path from 'node:path';import {createPaperPlugin} from ${url('chatbot/plugins/kurumi-papers/index.js')};import {PaperService} from ${url('chatbot/plugins/kurumi-papers/service.js')};import {pdf} from ${url('chatbot/tests/papers/fixtures.mjs')};export default createPaperPlugin({serviceFactory:(c,d)=>new PaperService(c,{...d,runner:async({work})=>{const dual=path.join(work,'dual.pdf');fs.writeFileSync(dual,pdf('fixture result'));return {dual};}})});`);
const sensitive=path.join(root,'access-probe');fs.mkdirSync(sensitive);
fs.writeFileSync(path.join(sensitive,'package.json'),JSON.stringify({name:'access-probe',type:'module',openclaw:{extensions:['./index.js']}}));
fs.writeFileSync(path.join(sensitive,'openclaw.plugin.json'),JSON.stringify({id:'access-probe',configSchema:{type:'object',properties:{}},contracts:{tools:['acl_sensitive','acl_background']},toolMetadata:{acl_sensitive:{optional:true},acl_background:{optional:true}}}));
fs.writeFileSync(path.join(sensitive,'index.js'),`import fs from 'node:fs';export default {id:'access-probe',register(api){for(const name of ['acl_sensitive','acl_background'])api.registerTool({name,label:'test',description:'Synthetic test tool',parameters:{type:'object',properties:{}},execute:async()=>{fs.writeFileSync(${JSON.stringify(root)}+'/'+name+'-ran','executed');return {content:[{type:'text',text:'probe-executed'}]};}},{name,optional:true});}};`);
const policy=ownerPolicy();policy.subjects.push(memberRow(),memberRow(OTHER));policy.subjects[1].permissions['papers.import']=false;
let cfg=JSON.parse(fs.readFileSync(path.join(repo,'config/runtime.config.json')));delete cfg._managed;
cfg.gateway={mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}};
cfg.models={providers:{fixture:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'synthetic',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}};
cfg.agents.defaults={workspace:path.join(root,'workspace'),model:{primary:'fixture/fixture'},heartbeat:{every:'0m'}};
cfg.agents.entries={main:{workspace:path.join(root,'workspace'),model:{primary:'fixture/fixture'},tools:{profile:'full',allow:['kurumi_document','kurumi_translate','kurumi_document_send','kurumi_task','acl_sensitive'],deny:['read','write','exec','process','message','automations','sessions_spawn']}},researcher:{workspace:path.join(root,'research-workspace'),model:{primary:'fixture/fixture'},tools:{profile:'full',allow:['acl_background']}}};
cfg.plugins={allow:['kurumi-qq','kurumi-papers','kurumi-tasks','access-probe'],load:{paths:[path.join(repo,'chatbot/plugins/kurumi-qq'),papers,path.join(repo,'chatbot/plugins/kurumi-tasks'),sensitive]},entries:{'kurumi-qq':{enabled:true},'kurumi-papers':{enabled:true,config:{root:path.join(root,'documents'),python:'/unused',credentialsFile:'/unused',liveTranslationEnabled:true}},'kurumi-tasks':{enabled:true},'access-probe':{enabled:true}},slots:{memory:'none'}};
cfg.tools={deny:['exec','process','message','sessions_spawn'],web:{search:{enabled:false},fetch:{enabled:false}}};cfg.cron={enabled:false};cfg.logging={file:path.join(root,'runtime.log')};
cfg.channels['kurumi-qq']={...cfg.channels['kurumi-qq'],httpUrl:`http://127.0.0.1:${server.address().port}`,wsUrl:`ws://127.0.0.1:${server.address().port}`,httpTokenFile:path.join(root,'http-token'),wsTokenFile:path.join(root,'ws-token'),stateDir:path.join(root,'channel'),mediaRoot:path.join(root,'media'),testIngress:true};
cfg=compileAccessConfig(cfg,policy);cfg.agents.entries['qq-user-'+MEMBER].tools.allow.push('acl_sensitive');
for(const file of ['http-token','ws-token'])fs.writeFileSync(path.join(root,file),token,{mode:0o600});
for(const row of policy.subjects){const dir=cfg.agents.entries[row.role==='owner'?'main':'qq-user-'+row.qq].workspace;fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.copyFileSync(path.join(repo,'roles/小鲸鱼.md'),path.join(dir,'SOUL.md'));fs.copyFileSync(path.join(repo,'scripts/fusion/templates',row.role==='owner'?'AGENTS.md':'MEMBER_AGENTS.md'),path.join(dir,'AGENTS.md'));}
fs.writeFileSync(path.join(root,'workspace/MEMORY.md'),'OWNER_PRIVATE_SENTINEL');
fs.writeFileSync(path.join(root,'openclaw.json'),JSON.stringify(cfg),{mode:0o600});
const catalogs=new Map();for(const id of [OWNER,MEMBER]){const docs=new Documents(id===OWNER?path.join(root,'documents'):path.join(root,'documents/subjects',id));const doc=await docs.add(pdf(id),{filename:id===OWNER?'owner-private.pdf':'member-own.pdf'},{inspect:async()=>({pages:1})});catalogs.set(id,{docs,doc});}
const fd=fs.openSync(path.join(root,'gateway.log'),'w',0o600);
const child=spawn(process.execPath,[path.join(repo,'node_modules/openclaw/openclaw.mjs'),'gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{cwd:repo,env:{...process.env,OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:path.join(root,'openclaw.json'),OPENCLAW_AGENT_DIR:path.join(root,'agents/main/agent')},stdio:['ignore',fd,fd],detached:true});fs.closeSync(fd);
const {callGatewayFromCli}=await import('openclaw/plugin-sdk/gateway-runtime');
const call=(method,params={},timeout=45000)=>callGatewayFromCli(method,{url:`ws://127.0.0.1:${port}`,token,timeout:String(timeout),json:true},params);let seq=1;
async function turn(id,text){const result=await call('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(id),message_id:++seq,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:(id===OWNER?'OWNER_TEST ':'MEMBER_TEST ')+text}}]}});report.lastResponse=result;return result;}
async function caseOf(label,fn){await fn();report.cases.push({label,passed:true});}
try{
 let ready=false;for(let i=0;i<100;i++){try{await call('health',{},1200);ready=true;break;}catch{if(child.exitCode!==null)throw Error('isolated_gateway_exited');await new Promise(r=>setTimeout(r,400));}}assert(ready,'isolated_gateway_not_ready');
 await caseOf('member actual trusted sender and private catalog',async()=>{const r=await turn(MEMBER,'ACL_CASE:list');assert(r.ok);assert(JSON.stringify(r.captured).includes('member-own.pdf'));assert(!JSON.stringify(r.captured).includes('owner-private.pdf'));});
 await caseOf('owner compatibility',async()=>{const r=await turn(OWNER,'ACL_CASE:list');assert(JSON.stringify(r.captured).includes('owner-private.pdf'));assert(!JSON.stringify(r.captured).includes('member-own.pdf'));});
 await caseOf('mandatory host policy denies unmapped exposed tool',async()=>{const r=await turn(MEMBER,'ACL_CASE:sensitive');assert(r.ok);assert(!fs.existsSync(path.join(root,'acl_sensitive-ran')));});
 await caseOf('mandatory host policy denies revoked import before HTTP',async()=>{const r=await turn(MEMBER,'ACL_CASE:import');assert(r.ok);assert(JSON.stringify(r.captured).includes('capability_not_allowed'));});
 let job;
 await caseOf('member background PDF bound to original QQ',async()=>{await turn(MEMBER,'ACL_CASE:translate '+catalogs.get(MEMBER).doc.id);for(let n=0;n<100;n++){const names=fs.readdirSync(path.join(root,'documents/jobs'));job=names.length?JSON.parse(fs.readFileSync(path.join(root,'documents/jobs',names[0]))):null;if(job?.delivery?.status==='platform_accepted')break;await new Promise(r=>setTimeout(r,50));}assert.equal(job?.status,'succeeded');assert.equal(job.requester.subjectId,MEMBER);assert.deepEqual(uploads.map(x=>x.qq),[MEMBER]);});
 await caseOf('other subject cannot inspect member job',async()=>{const r=await turn(OTHER,'ACL_CASE:status '+job.id);assert(JSON.stringify(r.captured).includes('paper_resource_not_found'));});
 await caseOf('member /new uses own native session and leaves files/jobs',async()=>{const event={post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(MEMBER),message_id:++seq,message:[{type:'text',data:{text:'/new'}}]};assert((await call('kurumi-qq.testInbound',{capture:true,event})).ok);const r=await turn(MEMBER,'ACL_CASE:list');assert(JSON.stringify(r.captured).includes('member-own.pdf'));assert.equal(fs.readdirSync(path.join(root,'documents/jobs')).length,1);});
 await caseOf('member prompts contain no owner memory and native sensitive tools are absent',async()=>{const memberChecks=modelChecks.filter(x=>x.member);assert(memberChecks.length);assert(memberChecks.every(x=>!x.ownerMemory));assert(memberChecks.every(x=>!x.tools.includes('sessions_history')&&!x.tools.includes('email_send')));assert(modelChecks.some(x=>!x.member&&x.ownerMemory));});
 await caseOf('owner task mints a trusted background lane and preserves configured tool access',async()=>{const r=await turn(OWNER,'ACL_CASE:research');assert(r.ok);for(let n=0;n<200&&!fs.existsSync(path.join(root,'acl_background-ran'));n++)await new Promise(r=>setTimeout(r,50));assert(fs.existsSync(path.join(root,'acl_background-ran')));});
 const audit=fs.readFileSync(path.join(root,'channel/access-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 await caseOf('trusted host policy audit proves calls reached enforceable boundary',async()=>{assert(audit.some(x=>x.data.code==='unmapped_tool'));assert(audit.some(x=>x.data.code==='capability_not_allowed'));assert(audit.some(x=>x.data.subjectId===MEMBER&&x.data.decision==='allow'));});
 report.passed=true;
}catch(e){report.passed=false;report.error=e.message;report.diagnosticsRoot=root;process.exitCode=1;}
finally{
 child.kill('SIGTERM');if(child.exitCode===null){let timer;await Promise.race([once(child,'exit'),new Promise(r=>timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}r();},20000))]);clearTimeout(timer);}
 for(const client of ws.clients)client.terminate();await new Promise(r=>ws.close(r));await new Promise(r=>server.close(r));await new Promise(r=>model.close(r));
 report.modelChecks=modelChecks;report.uploads=uploads;report.modelRequests=modelChecks.length;report.childStopped=child.exitCode!==null||child.signalCode!==null;
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));if(report.passed)fs.rmSync(root,{recursive:true,force:true});
 console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,error:report.error,evidence:out}));
}
