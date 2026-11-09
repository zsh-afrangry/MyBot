import {randomUUID} from 'node:crypto';
import {createWakeAuthority} from './authority.js';
import {createWakeService} from './service.js';
import {createSelfRecords} from './records.js';
import {digest,error} from './policy.js';

// Domain and host ports are supplied by the plugin composition root. All
// mutations/sends recheck the live capability at the final effect boundary.
export function createProactiveEngine({store,scope,authorize,getMemory,recent,runHost,query,sendText,catalog,now=Date.now,emit=()=>{}}) {
  const authority=createWakeAuthority({store,authorize,now}),records=createSelfRecords({store,scope,now}),runs=new Map(),pending=new Set();
  const track=work=>{pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work));return work;};
  store.db.exec(`CREATE TABLE IF NOT EXISTS wake_source (
    source_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,data_hash TEXT NOT NULL,
    created INTEGER NOT NULL,expires INTEGER NOT NULL);`);
  const source=(state,kind,id,data,expires=now()+86400000)=>{
    const sourceId=kind+':'+id;
    state.sources.add(sourceId);
    store.db.prepare(`INSERT INTO wake_source VALUES(?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
      run_id=excluded.run_id,data_hash=excluded.data_hash,created=excluded.created,expires=excluded.expires`)
      .run(sourceId,state.runId,kind,digest(JSON.stringify(data)),now(),expires);
    return sourceId;
  };
  const trace=(kind,data,runId)=>{try{emit(kind,data,runId);}catch{}};
  const service=createWakeService({authority,sendText,runModel:request=>track((async()=>{
    const state={runId:request.runId,sources:new Set(),observed:[],signal:request.signal};runs.set(request.runId,state);
    try {
      const memory=getMemory(),chat=recent.read(memory.generation),own=records.list(memory.generation);
      const facts=memory.facts.map(row=>({...row,sourceId:source(state,'memory',row.id+':'+digest(row.text).slice(0,16),row)}));
      const summaries=memory.recentSummaries.map(row=>({...row,sourceId:source(state,'summary',row.id,row,Date.parse(row.expiresAt))}));
      for(const row of chat)source(state,'recent',row.sourceId,row,row.expiresAt);
      const notes=own.slice(0,12).map(row=>({...row,sourceId:source(state,'record',row.id+':'+row.version,row,row.expiresAt)}));
      const context={asOf:now(),timeZone:request.binding.night.timeZone,memory:{revision:memory.revision,generation:memory.generation,facts,summaries},
        recent:chat.map(row=>({...row,sourceId:'recent:'+row.sourceId})),selfRecords:notes,selfRecordsTotal:own.length,capabilities:catalog,
        publicTools:request.binding.tools.filter(name=>['web_search','web_fetch'].includes(name)),
        control:{lastTrustedOwnerActivity:store.control(scope).last_activity,night:request.binding.night}};
      authority.assertCurrent(authority.resolve({runId:request.runId,agentId:request.binding.agentId,sessionKey:request.binding.sessionKey,sessionId:request.binding.sessionId}));
      const started=now(),result=await runHost({...request,context});
      trace('proactive.model',{durationMs:now()-started,usage:result.usage??null},request.runId);
      // Text is internal control only. It is never forwarded as a chat message.
      if(!result.decision||!['silent','done'].includes(result.decision.kind)||Object.keys(result.decision).length!==1)throw error('invalid_wake_decision');
      return {kind:store.messages(request.runId).length?'done':'silent'};
    } finally {runs.delete(request.runId);}
  })())});
  const engine={
    authority,records,
    observeTool(event,ctx) {
      if(!['web_search','web_fetch'].includes(event.toolName)||authority.toolDecision(event,ctx)?.block)return;
      const run=authority.assertCurrent(authority.resolve(ctx),ctx),state=runs.get(run.run_id),id=ctx.toolCallId??event.toolCallId;
      if(!state||typeof id!=='string'||!id)return;
      const outcome=event.error||event.result?.isError?'failed':'completed';
      const sourceId=source(state,'public',run.run_id+':'+id,{tool:event.toolName,result:event.result??null,outcome});
      state.observed.push({sourceId,tool:event.toolName,outcome,at:now()});
      trace('proactive.exploration',{sourceId,tool:event.toolName,status:outcome},run.run_id);
    },
    async wake(options) {
      const result=await service.wake(options),messages=result.runId?store.messages(result.runId):[];
      trace('proactive.run',{status:result.status,reason:result.reason??null,code:result.reason??null,messages:messages.map(m=>({status:m.status,key:m.message_key}))},result.runId);
      return {...result,messages};
    },
    async execute(ctx,callId,args) {
      if(authority.toolDecision({toolName:'kurumi_proactive'},ctx)?.block)throw error('wake_tool_not_allowed');
      const handle=authority.resolve(ctx),run=authority.assertCurrent(handle,ctx),state=runs.get(run.run_id);
      if(!state)throw error('untrusted_wake_context');
      const verify=()=>{state.signal.throwIfAborted();authority.assertCurrent(handle,ctx);};verify();
      if (!args||Object.keys(args).some(k=>!['action','kind','record','id','expectedVersion','text'].includes(k)))throw error('invalid_wake_action');
      if(args.action==='sources') {
        if(Object.keys(args).length!==1)throw error('invalid_wake_action');
        return {sources:structuredClone(state.observed)};
      }
      if(args.action==='query') {
        if(Object.keys(args).some(k=>!['action','kind'].includes(k))||!catalog.some(c=>c.kind===args.kind&&c.available))throw error('wake_query_not_allowed');
        let result;
        try{result=await query(args.kind,{runId:run.run_id,signal:state.signal,verify});verify();}
        catch(e){trace('proactive.query',{kind:args.kind,status:'failed',code:/^[a-z_]{1,60}$/.test(e.code??'')?e.code:'wake_query_failed'},run.run_id);throw e;}
        const sourceId=source(state,'query',randomUUID(),{kind:args.kind,result});
        trace('proactive.query',{kind:args.kind,sourceId,hash:digest(JSON.stringify(result))},run.run_id);
        return {sourceId,asOf:now(),data:result};
      }
      if(args.action==='remember') {
        if(Object.keys(args).some(k=>!['action','record'].includes(k)))throw error('invalid_wake_action');
        const liveSources=new Set([...state.sources].filter(id=>store.db.prepare('SELECT 1 FROM wake_source WHERE source_id=? AND expires>?').get(id,now())));
        verify();const result=records.put(args.record,{generation:run.binding.generation,knownSources:liveSources});
        source(state,'record',result.id+':'+result.version,result,result.expiresAt);
        trace('proactive.record',{action:'put',id:result.id,version:result.version},run.run_id);return result;
      }
      if(args.action==='forget') {
        if(Object.keys(args).some(k=>!['action','id','expectedVersion'].includes(k)))throw error('invalid_wake_action');
        if(!state.sources.has('record:'+args.id+':'+args.expectedVersion))throw error('wake_record_conflict');
        verify();const result=records.remove(args);trace('proactive.record',{action:'remove',id:result.id,version:result.version},run.run_id);return result;
      }
      if(args.action==='notify') {
        if(Object.keys(args).some(k=>!['action','text'].includes(k)))throw error('invalid_wake_action');
        const delivery=authority.prepareMessage(handle,callId,args.text);
        if(delivery.duplicate)return {status:delivery.status,duplicate:true};
        try {
          const receipt=await sendText({...delivery,text:args.text,signal:state.signal,assertCurrent:()=>{verify();delivery.assertCurrent();}});
          const row=delivery.recordReceipt(receipt);
          // Late platform facts survive reset/release; stale text must not
          // repopulate a cleared or newer short-lived context.
          if(row.status==='delivered')try{verify();recent.sent(delivery.key,args.text);}catch{}
          trace('proactive.delivery',{key:delivery.key,status:row.status},run.run_id);
          return {status:row.status,receipt:receipt?.status==='sent'?{messageId:receipt.messageId}:null};
        } catch {
          const row=delivery.recordReceipt({status:'unknown'});
          trace('proactive.delivery',{key:delivery.key,status:row.status},run.run_id);
          return {status:row.status};
        }
      }
      throw error('wake_action_not_allowed');
    },
    stop(){authority.invalidate(scope);},
    status(){return {control:store.control(scope),active:authority.activeCount()};},
  };
  return {...engine,execute:(...args)=>track(engine.execute(...args)),drain:()=>Promise.allSettled([...pending])};
}
