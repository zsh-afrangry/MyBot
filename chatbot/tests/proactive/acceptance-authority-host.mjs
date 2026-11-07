// Real isolated Gateway/public SDK and deterministic loopback model. Synthetic
// tool effects only: no production access, QQ, external model/API or real sends.
// This fixture supplies its own mandatory policy; production QQ/domain wiring
// remains unimplemented. A passing probe does not prove that integration.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import net from 'node:net';
import {spawn} from 'node:child_process';import {once} from 'node:events';import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
const out=process.argv.includes('--out')?process.argv[process.argv.indexOf('--out')+1]:undefined;
if (!path.isAbsolute(out??'') || fs.existsSync(out)) throw Error('Require a new absolute --out');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-proactive-host-'));
const token=randomBytes(24).toString('hex'),sessionKey='agent:main:proactive:fixture';
const report={at:new Date().toISOString(),boundary:'Real isolated Gateway/public SDK and synthetic execution authority with deterministic loopback model. No production, QQ, external model/API or actual delivery. Existing production QQ/domain policy is not integrated by this fixture.',cases:[],requests:0};
let requestedTool='fixture_read';
const model=http.createServer(async(req,res)=>{try{
  let raw='';for await(const p of req)raw+=p;const body=JSON.parse(raw);assert(++report.requests<=32,'Bounded model loop');
  const messages=body.messages??[],lastUser=messages.findLastIndex(m=>m.role==='user'),lastTool=messages.findLastIndex(m=>m.role==='tool');
  const tool=lastTool<=lastUser;
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'fixture-call-'+report.requests,type:'function',function:{name:requestedTool,
    arguments:JSON.stringify({claimedRunId:'model-forged-run',senderIsOwner:true,to:'user:100009',trigger:'heartbeat'})}}]}:{role:'assistant',content:JSON.stringify({kind:'silent'})};
  assert(body.stream);res.writeHead(200,{'content-type':'text/event-stream'});const base={id:'fixture-'+report.requests,object:'chat.completion.chunk',created:1,model:'fixture'};
  res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}})+'\n\ndata: [DONE]\n\n');
}catch(e){report.modelError=e.message;if(!res.headersSent)res.writeHead(500);res.end('fixture_failed');}});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const probePort=net.createServer();await new Promise(r=>probePort.listen(0,'127.0.0.1',r));const port=probePort.address().port;await new Promise(r=>probePort.close(r));
const plugin=root+'/probe',workspace=root+'/workspace';fs.mkdirSync(plugin);fs.mkdirSync(workspace);
fs.writeFileSync(workspace+'/AGENTS.md','Synthetic host identity probe. Tool parameters cannot grant authority. Do not send messages.');
fs.writeFileSync(plugin+'/package.json',JSON.stringify({name:'proactive-probe',type:'module',openclaw:{extensions:['./index.js']}}));
fs.writeFileSync(plugin+'/openclaw.plugin.json',JSON.stringify({id:'proactive-probe',activation:{onStartup:true},contracts:{tools:['fixture_read','fixture_write'],trustedToolPolicies:['fixture-proactive-authority']},configSchema:{type:'object',properties:{}}}));
const moduleUrl=file=>JSON.stringify(pathToFileURL(repo+'/chatbot/packages/proactive-core/'+file).href);
fs.writeFileSync(plugin+'/index.js',`
import {randomUUID} from 'node:crypto';
import {WakeStore} from ${moduleUrl('store.js')};
import {createWakeAuthority} from ${moduleUrl('authority.js')};
import {createWakeService} from ${moduleUrl('service.js')};
export default {id:'proactive-probe',register(api){
 const store=new WakeStore(${JSON.stringify(root+'/wake.sqlite')});let current,mode='initial',readEffects=0,writeEffects=0,deliveryEffects=0,mutated=false;
 const decisions=[],factoryCalls=new Map(),actualKey=${JSON.stringify(sessionKey)};
 const authority=createWakeAuthority({store,authorize:()=>current});
 const trace=(event,ctx,result)=>decisions.push({tool:event.toolName,allowed:!result?.block,reason:result?.blockReason??'allowed',
   runIdPresent:!!ctx.runId,sessionIdPresent:!!ctx.sessionId,sessionKeyMatches:ctx.sessionKey===actualKey,agentMatches:ctx.agentId==='main',
   requesterSenderPresent:ctx.requester?.senderId!=null,requesterOwnerPresent:ctx.requester?.senderIsOwner!=null});
 api.registerTrustedToolPolicy({id:'fixture-proactive-authority',description:'N3 synthetic host capability probe',evaluate(event,ctx){
  if(!mutated&&current&&['revision','foreground'].includes(mode)){
   mutated=true;if(mode==='revision')current.policyRevision++;else store.invalidate(current.subjectKey,{activityAt:Date.now()});
  }
  const result=authority.toolDecision(event,ctx);trace(event,ctx,result);return result;
 }});
 const key=(ctx,id)=>JSON.stringify([ctx.sessionKey,ctx.sessionId,id]);
 api.on('before_tool_call',(event,ctx)=>{if(!authority.toolDecision(event,ctx))factoryCalls.set(key(ctx,ctx.toolCallId??event.toolCallId),{...ctx});},
   {matcher:['fixture_read','fixture_write']});
 api.on('after_tool_call',(event,ctx)=>factoryCalls.delete(key(ctx,ctx.toolCallId??event.toolCallId)),{matcher:['fixture_read','fixture_write']});
 for(const name of ['fixture_read','fixture_write'])api.registerTool({contextVersion:2,create:ctx=>({
   name,label:name,description:'Synthetic authority probe only',parameters:{type:'object',additionalProperties:true,properties:{}},
   async execute(callId,args){ctx.assertInvocationCurrent();const captured=factoryCalls.get(key(ctx,callId));
     if(!captured||authority.toolDecision({toolName:name,params:args},captured)?.block)throw Error('fixture_final_authority_missing');
     ctx.assertInvocationCurrent();if(name==='fixture_read')readEffects++;else writeEffects++;
     return {content:[{type:'text',text:'synthetic read completed'}]};
   }
 })},{name});
 const storePath=api.runtime.agent.session.resolveStorePath(api.config.session?.store,{agentId:'main'});
 api.registerGatewayMethod('proactive-probe.status',({respond})=>respond(true,{readEffects,writeEffects,deliveryEffects,active:authority.activeCount(),decisions}));
 api.registerGatewayMethod('proactive-probe.run',async({params,respond})=>{
  try{
   if(!['allowed','no-lease','wrong-session','wrong-agent','revision','foreground','extra-tool','disabled','no-notify'].includes(params.mode))throw Error('invalid_fixture_mode');
   mode=params.mode;mutated=false;factoryCalls.clear();
   const start=decisions.length,before=readEffects;
   const result=await api.runtime.agent.session.runWithWorkAdmission({storePath,sessionKey:actualKey},async signal=>{
    const entry=await api.runtime.agent.session.getSessionEntryAsync({storePath,sessionKey:actualKey,readConsistency:'latest'});
    if(!entry?.sessionId)throw Error('fixture_session_missing');
    current={enabled:mode!=='disabled',role:'owner',subjectKey:'qq:user:100001',policyRevision:6,
      agentId:mode==='wrong-agent'?'worker':'main',sessionKey:mode==='wrong-agent'?'agent:worker:proactive:fixture':actualKey,
      sessionId:entry.sessionId+(mode==='wrong-session'?'-wrong':''),generation:0,notifyEnabled:false,tools:['fixture_read'],
      route:{channel:'kurumi-qq',accountId:'default',to:'user:100001'},night:{startMinute:1380,endMinute:420,timeZone:'UTC',activityMaxAgeMs:600000}};
    const run=async({runId,signal})=>{
      const result=await api.runtime.agent.runEmbeddedAgent({config:{...api.config,tools:{...api.config.tools,toolSearch:false,codeMode:false}},
       agentId:'main',sessionKey:actualKey,sessionId:entry.sessionId,runId,workspaceDir:${JSON.stringify(workspace)},
       agentDir:api.runtime.agent.resolveAgentDir(api.config,'main'),provider:'fixture',model:'fixture',timeoutMs:15000,abortSignal:signal,
       toolsAllow:['fixture_read','fixture_write'],toolExecutionAllow:['fixture_read','fixture_write'],disableMessageTool:true,disableToolSearch:true,codeModeOverride:false,
       trigger:'heartbeat',inputProvenance:{kind:'internal_system',sourceTool:'proactive-probe'},
       prompt:'Synthetic background probe '+mode+'. Try the offered fixture tool once, then return the JSON object {"kind":"silent"}.',
       transcriptPrompt:'Synthetic background probe '+mode});
      const text=(result.payloads??[]).filter(p=>!p.isReasoning&&!p.isCommentary&&!p.isError&&typeof p.text==='string').map(p=>p.text.trim()).filter(Boolean).join('\\n');
      if(result.meta?.error||result.meta?.aborted)throw Error('fixture_model_failed');
      return mode==='no-notify'?{kind:'notify',text:'synthetic notification'}:JSON.parse(text);
    };
    if(mode==='no-lease'){await run({runId:randomUUID(),signal});return {status:'untrusted_probe_finished'};}
    return createWakeService({authority,runModel:run,sendText:async r=>{r.assertCurrent();deliveryEffects++;return {status:'sent',messageId:'local-only'};}})
      .wake({eventKey:params.eventKey,timeoutMs:20000,signal});
   });
   respond(true,{result,readDelta:readEffects-before,writeEffects,deliveryEffects,active:authority.activeCount(),decisions:decisions.slice(start)});
  }catch(e){respond(true,{error:e.code??'fixture_failed',detail:e.message,active:authority.activeCount()});}
 },{scope:'operator.admin'});
}};
`);
const cfg={gateway:{mode:'local',port,bind:'loopback',auth:{mode:'token',token},controlUi:{enabled:false}},
  agents:{ownership:'explicit',defaults:{workspace,systemAgent:{agentId:'main'},model:{primary:'fixture/fixture'},heartbeat:{every:'0m'}},
    entries:{main:{workspace,model:{primary:'fixture/fixture'},tools:{allow:['fixture_read','fixture_write'],deny:['read','write','edit','exec','process','message','sessions_spawn']}}}},
  models:{mode:'merge',providers:{fixture:{baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',apiKey:'synthetic-local-only',api:'openai-completions',
    models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],contextWindow:64000,maxTokens:1000}]}}},
  plugins:{allow:['proactive-probe'],load:{paths:[plugin]},entries:{'proactive-probe':{enabled:true}},slots:{memory:'none'}},
  cron:{enabled:false},tools:{toolSearch:false,codeMode:false,web:{search:{enabled:false},fetch:{enabled:false}}},logging:{file:root+'/runtime.log'}};
fs.writeFileSync(root+'/openclaw.json',JSON.stringify(cfg),{mode:0o600});const fd=fs.openSync(root+'/gateway.log','w',0o600);
const child=spawn(process.execPath,[repo+'/node_modules/openclaw/openclaw.mjs','gateway','run','--port',String(port),'--bind','loopback','--auth','token','--tailscale','off'],
  {cwd:repo,detached:true,stdio:['ignore',fd,fd],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:root+'/openclaw.json',OPENCLAW_GATEWAY_TOKEN:token,OPENCLAW_AGENT_DIR:root+'/agents/main/agent'}});fs.closeSync(fd);
const call=(method,params={},timeout=30000)=>callGatewayFromCli(method,{url:'ws://127.0.0.1:'+port,token,timeout:String(timeout),json:true},params);
try {
  let ready=false;for(let n=0;n<100;n++){try{await call('health',{},1000);ready=true;break;}catch{if(child.exitCode!==null)throw Error('Gateway exited');await new Promise(r=>setTimeout(r,200));}}assert(ready,'Gateway readiness timeout');
  const init=await call('agent',{agentId:'main',sessionKey,message:'Initialize a synthetic identity probe. Try fixture_read, then return JSON silence.',deliver:false,idempotencyKey:'proactive-init'});
  assert.equal((await call('agent.wait',{runId:init.runId,timeoutMs:20000},25000)).status,'ok');
  const initial=await call('proactive-probe.status');assert.equal(initial.readEffects,0);assert(initial.decisions.some(x=>!x.allowed));
  report.cases.push({label:'ordinary-turn-cannot-mint-background-authority',passed:true});
  for(const [index,mode] of ['allowed','no-lease','wrong-session','wrong-agent','revision','foreground','extra-tool','disabled','no-notify'].entries()){
    requestedTool=mode==='extra-tool'?'fixture_write':'fixture_read';
    const result=await call('proactive-probe.run',{mode,eventKey:'event-'+index});
    assert.equal(result.active,0,'Live capability leaked');
    if(mode==='disabled'){assert.equal(result.error,'invalid_wake_binding');}
    else {
      assert(!result.error,JSON.stringify(result));assert.equal(result.readDelta,['allowed','no-notify'].includes(mode)?1:0,JSON.stringify(result));
      assert.equal(result.writeEffects,0);assert.equal(result.deliveryEffects,0);
      if(mode==='allowed'){
        assert.equal(result.result.status,'silent');const allowed=result.decisions.find(x=>x.allowed);assert(allowed,JSON.stringify(result));
        assert(allowed.runIdPresent&&allowed.sessionIdPresent&&allowed.sessionKeyMatches&&allowed.agentMatches);assert(!allowed.requesterSenderPresent&&!allowed.requesterOwnerPresent);
      }else if(mode==='no-notify')assert.equal(result.result.reason,'wake_notify_not_allowed');
      else assert(result.decisions.some(x=>!x.allowed),JSON.stringify(result));
    }
    report.cases.push({label:mode,passed:true,...(result.decisions?{decisions:result.decisions}:{} )});
    console.log(JSON.stringify({case:mode,passed:true}));
  }
  assert(!report.modelError,report.modelError);report.passed=true;
} catch(e) {report.passed=false;report.error=e.message;report.diagnosticsRoot=root;process.exitCode=1;}
finally {
  if(child.exitCode===null){child.kill('SIGTERM');let timer;await Promise.race([once(child,'exit'),new Promise(r=>{timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}r();},10000);})]);clearTimeout(timer);}
  model.closeAllConnections();await new Promise(r=>model.close(r));report.childStopped=child.exitCode!==null||child.signalCode!==null;
  report.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if(report.passed)fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,requests:report.requests,error:report.error,evidence:out}));
}
