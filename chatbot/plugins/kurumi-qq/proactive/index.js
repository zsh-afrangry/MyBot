import fs from 'node:fs';
import path from 'node:path';
import {createRuntimeConfigReader} from 'openclaw/plugin-sdk/runtime-config-snapshot';
import {activeSubject,primaryOwner,accessPolicy,authorizedOwner} from '../../../packages/access-control/index.js';
import {trustedText} from '../../../packages/trusted-inbound/index.js';
import {createTraceSink} from '../../../packages/observability/index.js';
import {WakeStore} from '../../../packages/proactive-core/store.js';
import {createProactiveEngine} from '../../../packages/proactive-core/engine.js';
import {createWakeLifecycle} from '../../../packages/proactive-core/lifecycle.js';
import {createRecentContext} from '../../../packages/proactive-core/context.js';
import {createWakeScheduler} from '../../../packages/proactive-core/scheduler.js';
import {digest,error,binding,isWakeSession} from '../../../packages/proactive-core/policy.js';
import {createDomainAdapters,capabilityCatalog} from './adapters.js';
import {createHostAdapter} from './host.js';

const json=result=>({content:[{type:'text',text:JSON.stringify(result)}],details:result});
const properties={action:{type:'string',enum:['status','records','pause','resume','record_put','record_remove','query','remember','forget','notify','sources']},
  kind:{type:'string',enum:capabilityCatalog.map(c=>c.kind)},text:{type:'string',minLength:1,maxLength:2000},
  id:{type:'string'},expectedVersion:{type:'integer',minimum:1},
  offset:{type:'integer',minimum:0},
  record:{type:'object',additionalProperties:false,required:['kind','text','ttlDays'],properties:{id:{type:'string'},expectedVersion:{type:'integer',minimum:1},
    kind:{type:'string',enum:['interest','experience','intention']},text:{type:'string',minLength:1,maxLength:1200},
    sources:{type:'array',minItems:1,maxItems:8,items:{type:'string'}},ttlDays:{type:'integer',minimum:1,maximum:90}}}};
export const toolDeclaration={name:'kurumi_proactive',label:'自主行动与自身记录',
  description:'主人私聊：status/records查看自主行动及独立自身记录（records每页50条，按nextOffset继续，含已过期或旧代记录）；pause/resume暂停恢复；record_put/record_remove按真实ID/version更正删除自身记录。后台凭据：query按kind查询只读领域，remember维护自己的记录（sources须用本回合实际sourceId），forget删除已读自身记录，notify主动发言。后台不接受聊天身份、目标、权限或调度参数，不改主人记忆或业务。未提供工具/用途时不可调用。',
  parameters:{type:'object',additionalProperties:false,required:['action'],properties}};
export function validateSettings(value) {
  if(!value||value.enabled!==true||!Number.isSafeInteger(value.revision)||value.revision<1
    ||!Number.isSafeInteger(value.intervalMs)||value.intervalMs<60000||value.intervalMs>86400000
    ||!Number.isSafeInteger(value.timeoutMs)||value.timeoutMs<1000||value.timeoutMs>120000
    ||typeof value.notifyEnabled!=='boolean'||!Array.isArray(value.reads)||new Set(value.reads).size!==value.reads.length
    ||value.reads.some(s=>!capabilityCatalog.some(c=>c.kind===s))||typeof value.publicSearch!=='boolean')throw error('invalid_proactive_config');
  // Reuse the authority's exact validation for all night parameters.
  binding({enabled:true,role:'owner',subjectKey:'qq:user:100001',policyRevision:1,agentId:'main',sessionKey:'agent:main:validation',sessionId:'validation',generation:0,
    notifyEnabled:value.notifyEnabled,tools:[],route:{channel:'kurumi-qq',accountId:'default',to:'user:100001'},night:value.night});
  return value;
}
export function createProactiveComponent(dependencies={}) {
  return {id:'kurumi-proactive',name:'Kurumi autonomous opportunities',register(api) {
    const full=api.registrationMode===undefined||api.registrationMode==='full';
    // Disabled/discovery registration cannot create state, timers or grants.
    if(api.pluginConfig?.proactive?.enabled!==true)return;
    const settings=validateSettings(api.pluginConfig.proactive),getConfig=dependencies.getConfig??createRuntimeConfigReader(api.config);
    const stateRoot=dependencies.stateRoot??process.env.OPENCLAW_STATE_DIR;
    if(!path.isAbsolute(stateRoot??''))throw error('invalid_proactive_state');
    const ownerId=primaryOwner(api.config).qq,scope='qq:user:'+ownerId,key='agent:main:kurumi-proactive:'+ownerId;
    const calls=new Map(),recent=createRecentContext({ownerId});
    let store,engine,lifecycle,scheduler,prepared,attempt,accepting=false,emitEvent=()=>{};
    const pending=new Set(),adapters=dependencies.adapters??createDomainAdapters({getConfig,ownerId,stateRoot});
    const currentSettings=()=>{
      const value=validateSettings(getConfig().plugins.entries['kurumi-qq']?.config?.proactive);
      if(JSON.stringify(value)!==JSON.stringify(settings))throw error('wake_policy_changed');
      return value;
    };
    const policyStamp=cfg=>digest(JSON.stringify({settings:cfg.plugins.entries['kurumi-qq']?.config?.proactive,access:accessPolicy(cfg),tools:cfg.agents.entries.main.tools}));
    const permittedTools=cfg=>{
      const tools=cfg.agents.entries.main.tools,allowed=new Set([...(tools?.allow??[]),...(tools?.alsoAllow??[])]);
      if(!allowed.has('kurumi_proactive')||tools?.deny?.includes('kurumi_proactive'))throw error('wake_tool_not_allowed');
      return ['kurumi_proactive',...(settings.publicSearch?['web_search','web_fetch'].filter(name=>allowed.has(name)&&!tools?.deny?.includes(name)):[])];
    };
    const authorize=()=>{
      const cfg=getConfig(),options=currentSettings(),tools=permittedTools(cfg);activeSubject(cfg,ownerId,'proactive.use');activeSubject(cfg,ownerId,'memory.read');
      if(primaryOwner(cfg).qq!==ownerId||!prepared||prepared.stamp!==policyStamp(cfg))throw error('wake_policy_changed');
      if(options.notifyEnabled)activeSubject(cfg,ownerId,'proactive.notify');
      const memory=adapters.memory();recent.read(memory.generation);
      return {enabled:true,role:'owner',subjectKey:scope,policyRevision:accessPolicy(cfg).revision,
        agentId:'main',sessionKey:key,sessionId:prepared.sessionId,generation:memory.generation,notifyEnabled:options.notifyEnabled,
        tools,
        route:{channel:'kurumi-qq',accountId:'default',to:'user:'+ownerId},night:options.night};
    };
    const host=dependencies.host??createHostAdapter({api,getConfig,timeoutMs:settings.timeoutMs,prepare:value=>{prepared={...value,stamp:policyStamp(getConfig())};}});
    const callKey=(ctx,id)=>JSON.stringify([ctx.sessionKey,ctx.sessionId,id]);
    async function wake({eventKey,signal}={}) {
      if(!accepting||!engine)throw error('wake_service_unavailable');
      if(attempt)return {status:'skipped',reason:'busy'};
      if(store.control(scope).paused)return {status:'skipped',reason:'paused'};
      const controller=new AbortController();attempt=controller;
      const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      try {return await host.admitted(s=>engine.wake({eventKey,timeoutMs:settings.timeoutMs,signal:s}),{signal:combined});}
      catch(e){return combined.aborted?{status:'cancelled',reason:'wake_aborted'}
        :{status:'failed',reason:/^(wake_|invalid_|night_)[a-z_]+$/.test(e.code??'')?e.code:'wake_admission_failed'};}
      finally {if(attempt===controller)attempt=undefined;prepared=undefined;calls.clear();}
    }
    const trackedWake=options=>{const work=wake(options);pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work));return work;};
    const provider={toolDecision:(event,ctx)=>{
      if(!engine||!accepting)return {block:true,blockReason:'wake_composition_unavailable'};
      const cfg=getConfig();if(event.toolName==='web_search'||event.toolName==='web_fetch')try{activeSubject(cfg,ownerId,'search.use');}catch{return {block:true,blockReason:'wake_query_not_allowed'};}
      if(engine.authority.activeCount()===0)return {block:true,blockReason:'wake_no_active_capability'};
      return engine.authority.toolDecision(event,ctx);
    },acceptInbound(meta){if(!engine||!accepting||!lifecycle.acceptInbound(meta))return;recent.accepted(meta);attempt?.abort();}};
    if(full) {
      api.on('before_tool_call',(event,ctx)=>{
        if(event.toolName!=='kurumi_proactive')return;
        ctx.hookInvocation?.assertActive();
        if(isWakeSession(ctx)&&engine?.authority.toolDecision(event,ctx)?.block)return;
        calls.set(callKey(ctx,ctx.toolCallId??event.toolCallId),ctx);
      },{matcher:['kurumi_proactive']});
      api.on('after_tool_call',(event,ctx)=>calls.delete(callKey(ctx,ctx.toolCallId??event.toolCallId)),{matcher:['kurumi_proactive']});
      api.on('after_tool_call',(event,ctx)=>{try{engine?.observeTool(event,ctx);}catch{}},{matcher:['web_search','web_fetch']});
      api.on('reply_dispatch',event=>{
        if(!engine)return;
        const raw=trustedText(event.ctx,ownerId,event);if(raw)recent.receive(event.ctx,raw);
      });
      const end=(event={},ctx={})=>{
        const target=ctx.sessionKey??event.sessionKey,agent=ctx.agentId??event.agentId;
        if((target!==key&&target!=='agent:main:kurumi-qq:direct:'+ownerId)
          ||(agent!==undefined&&agent!=='main')
          ||(ctx.sessionKey&&event.sessionKey&&ctx.sessionKey!==event.sessionKey))return;
        attempt?.abort();engine?.authority.invalidate(scope);recent.clear();calls.clear();
      };
      api.on('before_reset',end);api.on('session_end',end);
      api.registerService({id:'kurumi-proactive',start(){
        permittedTools(getConfig());
        activeSubject(getConfig(),ownerId,'proactive.use');activeSubject(getConfig(),ownerId,'memory.read');
        if(settings.notifyEnabled)activeSubject(getConfig(),ownerId,'proactive.notify');
        adapters.memory();
        const root=path.join(stateRoot,'state/proactive');
        fs.mkdirSync(root,{recursive:true,mode:0o700});
        if(fs.realpathSync(root)!==path.resolve(root)||fs.statSync(root).mode&0o077)throw error('invalid_proactive_state');
        store=new WakeStore(path.join(root,'proactive.sqlite'));store.recover(Date.now());
        const sink=dependencies.emit??((kind,data,runId)=>createTraceSink(path.join(root,'trace.jsonl'),{maxBytes:4*1024*1024}).emit({source:'proactive',kind,correlation:{runId},data}));
        emitEvent=(...args)=>{try{sink(...args);}catch{}};
        engine=createProactiveEngine({store,scope,authorize,getMemory:adapters.memory,recent,runHost:host.model,query:adapters.query,sendText:adapters.send,
          catalog:capabilityCatalog.map(c=>({...c,available:settings.reads.includes(c.kind)})),emit:sink});
        lifecycle=createWakeLifecycle({authority:engine.authority,ownerId,activityMaxAgeMs:settings.night.activityMaxAgeMs});
        accepting=true;
        scheduler=createWakeScheduler({intervalMs:settings.intervalMs,wake:trackedWake});scheduler.start();
      },async stop(){accepting=false;scheduler?.stop();attempt?.abort();engine?.stop();
        await Promise.allSettled([...pending]);await engine?.drain();recent.clear();calls.clear();store?.close();store=undefined;engine=undefined;
      }});
      api.registerGatewayMethod('kurumi-proactive.run',async({params,respond,hasCurrentClientAuthority})=>{
        if(hasCurrentClientAuthority&&!hasCurrentClientAuthority())return respond(false,undefined,{code:'UNAVAILABLE',message:'Expired operator authority'});
        if(Object.keys(params??{}).some(k=>k!=='eventKey')||typeof params?.eventKey!=='string')return respond(false,undefined,{code:'INVALID_REQUEST',message:'eventKey required'});
        respond(true,await trackedWake({eventKey:params.eventKey}));
      },{scope:'operator.admin'});
      api.registerGatewayMethod('kurumi-proactive.status',({respond})=>respond(true,engine?{...engine.status(),scheduler:scheduler.status()}:{enabled:false}),{scope:'operator.admin'});
    }
    api.registerTool({contextVersion:2,create:ctx=>({...toolDeclaration,async execute(callId,args,signal){
      try {
        ctx.assertInvocationCurrent();signal?.throwIfAborted();if(!engine)throw error('wake_service_unavailable');
        const actual=calls.get(callKey(ctx,callId));if(!actual)throw error('untrusted_wake_context');
        if(isWakeSession(actual))return json(await engine.execute(actual,callId,args));
        if(!['status','records','pause','resume','record_put','record_remove'].includes(args?.action)
          ||!authorizedOwner(ctx,getConfig(),['status','records'].includes(args.action)?'proactive.read':'proactive.manage'))throw error('wake_owner_required');
        const allowed=args.action==='records'?['action','offset']:['action','record','id','expectedVersion'];
        if(Object.keys(args).some(k=>!allowed.includes(k)))throw error('invalid_wake_action');
        const generation=adapters.memory().generation;
        if(args.action==='status')return json({...engine.status(),scheduler:scheduler.status()});
        if(args.action==='records')return json(engine.records.page(generation,{offset:args.offset}));
        if(['pause','resume'].includes(args.action)){
          attempt?.abort();return json(engine.authority.invalidate(scope,{paused:args.action==='pause'}));
        }
        // Owner changes revoke in-flight decisions before changing notes.
        attempt?.abort();engine.authority.invalidate(scope);ctx.assertInvocationCurrent();
        if(args.action==='record_remove'){
          const result=engine.records.remove(args);emitEvent('proactive.record',{action:'owner_remove',id:result.id,version:result.version},actual.runId);return json(result);
        }
        const source='owner:'+digest(actual.runId+':'+callId).slice(0,24);
        const result=engine.records.put({...args.record,sources:[source]},{generation,knownSources:new Set([source]),owner:true});
        emitEvent('proactive.record',{action:'owner_put',id:result.id,version:result.version},actual.runId);return json(result);
      }catch(e){return json({ok:false,error:{code:/^(wake_|untrusted_|invalid_|night_)[a-z_]+$/.test(e.code??'')?e.code:'wake_operation_failed'}});}
    }})},{name:'kurumi_proactive',optional:true});
    return provider;
  }};
}
