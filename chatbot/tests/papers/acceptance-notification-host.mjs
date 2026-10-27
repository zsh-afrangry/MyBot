// Real isolated Gateway and plugin session runner with a local deterministic model.
// Fake publisher; no external API, real model, QQ/mail, credentials or production state.
// Writes temporary state and a new explicit --out report only. Contract: docs/22.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';

const out = process.argv[process.argv.indexOf('--out')+1];
const legacyScope = process.argv.includes('--legacy-scope'); // Negative control: reproduce the old queue ownership.
if (!process.argv.includes('--out') || !path.isAbsolute(out ?? '') || fs.existsSync(out)) throw Error('Require a new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-paper-notice-host-'));
const token=randomBytes(24).toString('hex'),sessionKey='agent:main:notice-fixture',modelRequests=[];
const responseText='这篇论文在翻译正文时达到本地单篇用量上限，尚无完整译文；这不能说明账号余额不足。请确认页码或预算后再安排重试。';
const model=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw),messages=body.messages??[],available=(body.tools??[]).map(t=>t.function?.name);
  const submitted=JSON.stringify(messages).includes('notice-fixture-submitted');
  let tool;
  if(available.length && !submitted){
    if(available.includes('paper_notice_probe'))tool=['paper_notice_probe',{}];
    else if(available.includes('tool_search'))tool=messages.some(m=>m.role==='tool')?['tool_call',{id:'paper_notice_probe',args:{}}]:['tool_search',{query:'paper_notice_probe',limit:1}];
    else throw Error('Fixture tool is unavailable');
  }
  modelRequests.push({tools:available.length,model:body.model,explanation:available.length===0,tool:tool?.[0]});
  const delta=tool?{role:'assistant',content:null,tool_calls:[{index:0,id:'call_fixture_'+modelRequests.length,type:'function',function:{name:tool[0],arguments:JSON.stringify(tool[1])}}]}:{role:'assistant',content:responseText};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const frame=value=>res.write('data: '+JSON.stringify(value)+'\n\n');
  frame({id:'fixture-'+modelRequests.length,object:'chat.completion.chunk',created:1,model:'notice-fixture',choices:[{index:0,delta,finish_reason:null}]});
  frame({id:'fixture-'+modelRequests.length,object:'chat.completion.chunk',created:1,model:'notice-fixture',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:12,completion_tokens:10,total_tokens:22}});
  res.end('data: [DONE]\n\n');
});
model.listen(0,'127.0.0.1');await once(model,'listening');
const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
const probe=path.join(root,'probe'),workspace=path.join(root,'workspace');fs.mkdirSync(probe);fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace,'AGENTS.md'),'For initialization, call the synthetic paper_notice_probe once. For background results, explain only.');
fs.writeFileSync(path.join(probe,'package.json'),JSON.stringify({name:'paper-notice-probe',type:'module',openclaw:{extensions:['./index.js']}}));
fs.writeFileSync(path.join(probe,'openclaw.plugin.json'),JSON.stringify({id:'paper-notice-probe',activation:{onStartup:true},contracts:{tools:['paper_notice_probe']},toolMetadata:{paper_notice_probe:{optional:true}},configSchema:{type:'object',properties:{}}}));
const moduleUrl=name=>pathToFileURL(path.join(repo,'chatbot/plugins/kurumi-papers',name)).href;
fs.writeFileSync(path.join(probe,'index.js'),`
import {createFailureNotifier} from ${JSON.stringify(moduleUrl('notification.js'))};
import {failureSummary} from ${JSON.stringify(moduleUrl('failure.js'))};
import {PaperService} from ${JSON.stringify(moduleUrl('service.js'))};
export default {id:'paper-notice-probe',register(api){
 const sent=[],request={subjectId:'fixture',agentId:'main',sessionKey:${JSON.stringify(sessionKey)},accountId:'default',to:'user:fixture'};let release,queued;
 const gate=new Promise(resolve=>{release=resolve;});
 const notify=createFailureNotifier({runtime:api.runtime,workflow:api.session.workflow,config:()=>api.config,
 authorize:r=>{if(r!==request)throw Error('identity mismatch');},
 sendText:async value=>{sent.push({to:value.to,key:value.key,text:value.text});return{status:'sent'};}});
 const service=new PaperService({root:${JSON.stringify(path.join(root,'papers'))},liveTranslationEnabled:true},{ownerBinding:request,notify,
  documentsFor:()=>({root:${JSON.stringify(path.join(root,'papers'))},describe:()=>({id:'doc_'+'b'.repeat(32),pages:1,filename:'fixture.pdf'}),get:()=>({content:Buffer.from('%PDF-1.4 synthetic')})}),
  runner:async()=>{await gate;throw Object.assign(Error('Synthetic worker failure'),{code:'translation_budget_exhausted'});}
 });
 ${legacyScope ? 'service.scheduleDrain=()=>queueMicrotask(()=>{void service.drain();});' : ''}
 api.registerService({id:'paper-notice-fixture-jobs',start:()=>service.start(),stop:()=>{release();return service.stop();}});
 api.registerTool({name:'paper_notice_probe',label:'Queue synthetic paper job',description:'Queue a synthetic delayed worker without external calls.',parameters:{type:'object',properties:{}},execute:async()=>{
  queued=service.submit({documentId:'doc_'+'b'.repeat(32),delivery:'none'},{key:'fixture-native-tool'});
  return{content:[{type:'text',text:JSON.stringify({marker:'notice-fixture-submitted',jobId:queued.id})}]};
 }},{name:'paper_notice_probe',optional:true});
 api.registerGatewayMethod('paper-notice-probe.release',({respond})=>{release();respond(true,{released:true});});
 api.registerGatewayMethod('paper-notice-probe.result',({respond})=>respond(true,{job:queued?service.status(queued.id):null,sent}));
 api.registerGatewayMethod('paper-notice-probe.explain',async({respond})=>{
  const summary=failureSummary({id:'job_'+'a'.repeat(24),status:'failed',error:'translation_budget_exhausted',
   profile:{provider:'deepseek',channel:'official',model:'deepseek-flash',effort:'high'},engineProgress:{stage:'Translate Paragraphs'},
   usage:{reportedTokens:375,maxReportedTokens:300,failureDetails:{budgetExhaustedBy:'reported_tokens'}}});
  const receipt=await notify(summary,summary.jobId,request);respond(true,{receipt,sent});
 });
}};
`);
const cfg={
 gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},
 agents:{defaults:{workspace,model:{primary:'fixture/notice-fixture'},heartbeat:{every:'0m'}},entries:{main:{workspace,model:{primary:'fixture/notice-fixture'},tools:{allow:['paper_notice_probe']}}}},
 models:{mode:'merge',providers:{fixture:{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',apiKey:'synthetic-local-only',api:'openai-completions',models:[{id:'notice-fixture',name:'Local notice fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000}]}}},
 plugins:{allow:['paper-notice-probe'],load:{paths:[probe]},entries:{'paper-notice-probe':{enabled:true}},slots:{memory:'none'}},
 cron:{enabled:false},tools:{web:{search:{enabled:false},fetch:{enabled:false}}},logging:{file:path.join(root,'runtime.log')},
};
const configFile=path.join(root,'openclaw.json');fs.writeFileSync(configFile,JSON.stringify(cfg),{mode:0o600});
const fd=fs.openSync(path.join(root,'gateway.log'),'w',0o600);
const child=spawn(process.execPath,[path.join(repo,'node_modules/openclaw/openclaw.mjs'),'gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],{
 cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:configFile,OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_AGENT_DIR:path.join(root,'agents/main/agent')},
});fs.closeSync(fd);
const call=(method,params={},timeout=15000)=>callGatewayFromCli(method,{url:'ws://127.0.0.1:'+port,token,timeout:String(timeout),json:true},params);
try {
 let ready=false;
 for(let i=0;i<100;i++){
  try{await call('health',{},1000);ready=true;break;}catch{if(child.exitCode!==null)throw Error('Isolated Gateway exited; diagnostic directory: '+root);await new Promise(r=>setTimeout(r,200));}
 }
 assert(ready,'Gateway readiness timeout');
 const init=await call('agent',{agentId:'main',sessionKey,message:'Initialize the synthetic fixture conversation.',deliver:false,idempotencyKey:'notice-fixture-init'});
 const initialized=await call('agent.wait',{runId:init.runId,timeoutMs:30000},35000);assert.equal(initialized.status,'ok');
 const waiting=await call('paper-notice-probe.result');assert.equal(waiting.job?.status,'running');assert.equal(waiting.sent.length,0);
 const result=await call('paper-notice-probe.explain',{},55000);
 assert.equal(result.receipt.mode,'assistant',JSON.stringify(result.receipt));assert.equal(result.sent.length,1);assert.equal(result.sent[0].to,'user:fixture');
 assert.match(result.sent[0].text,/本地单篇/);assert.match(result.sent[0].text,/job_a{24}/);
 await call('paper-notice-probe.release');let delayed;
 for(let i=0;i<200;i++){
  delayed=await call('paper-notice-probe.result');
  if(delayed.job?.notification?.status && delayed.job.notification.status!=='pending')break;
  await new Promise(r=>setTimeout(r,100));
 }
 assert.equal(delayed.job.notification?.mode,legacyScope?'fallback':'assistant',JSON.stringify(delayed.job.notification));
 assert.equal(delayed.sent.length,2);assert.equal(delayed.sent[1].to,'user:fixture');assert.match(delayed.sent[1].text,new RegExp(delayed.job.id));
 const explanations=modelRequests.filter(r=>r.explanation);assert.equal(explanations.length,legacyScope?1:2);assert(explanations.every(r=>r.tools===0));
 assert(modelRequests.some(r=>['paper_notice_probe','tool_call'].includes(r.tool)));
 const runtimeLog=fs.readFileSync(path.join(root,'runtime.log'),'utf8'),closedScopeErrors=runtimeLog.split('\n').filter(line=>line.includes('Async work scope is closed')).length;
 assert.equal(closedScopeErrors,0);
 if(legacyScope)assert.equal(delayed.job.notification.explanationError,'assistant_notice_run_failed');
 const report={at:new Date().toISOString(),boundary:'真实隔离Gateway及注册插件会话运行入口，本地确定性模型与假投递器；无真实模型/API/QQ、凭据或生产写入。',passed:true,
  modelRequests:modelRequests.length,explanationRequests:explanations.length,allExplanationRequestsToolFree:true,notification:result.receipt,
  delayedNotification:delayed.job.notification,delayedJobReleasedAfterToolTurnCompleted:true,legacyScopeNegativeControl:legacyScope,closedWorkScopeErrors:closedScopeErrors,
  sends:delayed.sent.map(r=>({to:r.to,key:r.key,hasDiagnostic:true})),chatInitialized:true};
 fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,modelRequests:modelRequests.length,mode:result.receipt.mode,out}));
} finally {
 try{process.kill(-child.pid,'SIGTERM');}catch{}
 if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,3000))]);
 if(child.exitCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}
 await new Promise(r=>model.close(r));
}
