// Live, host-minted capability. Model-facing args never reach begin().
import {randomUUID} from 'node:crypto';
import {binding,fingerprint,error,digest,assertContactTime,time,decision} from './policy.js';

export function createWakeAuthority({store,authorize,now=Date.now}) {
  const active=new Map();
  const trusted=()=>binding(authorize());
  const handleRun=handle=>{
    if (!handle || active.get(handle.runId)!==handle) throw error('untrusted_wake');
    return handle.runId;
  };
  function assertCurrent(handle,ctx,statuses=['running']) {
    const run=store.assertLive(handleRun(handle),now(),statuses),fresh=trusted();
    if (fingerprint(run.binding)!==fingerprint(fresh)) throw error('wake_policy_changed');
    if (ctx && (ctx.runId!==run.run_id || ctx.sessionKey!==fresh.sessionKey || ctx.sessionId!==fresh.sessionId
      || ctx.agentId!==fresh.agentId || ctx.abortSignal?.aborted
      || ctx.requester?.senderId!=null || ctx.requester?.senderIsOwner!=null)) throw error('untrusted_wake_context');
    return run;
  }
  return {
    begin({eventKey,timeoutMs=60000}) {
      if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>120000) throw error('invalid_wake_timeout');
      const selected=trusted(),at=time(now()),runId=randomUUID();
      const result=store.claim({runId,eventKey,binding:selected,now:at,expires:at+timeoutMs});
      if (result.skip) return result;
      const handle=Object.freeze({runId});active.set(runId,handle);
      return {handle,run:result.run};
    },
    assertCurrent,
    toolDecision(event,ctx) {
      try {
        const handle=active.get(ctx?.runId),run=assertCurrent(handle,ctx);
        if (!run.binding.tools.includes(event.toolName)) throw error('wake_tool_not_allowed');
      } catch (e) {return {block:true,blockReason:e.code??'untrusted_wake'};}
    },
    prepareDelivery(handle,text) {
      text=decision({kind:'notify',text}).text;
      const run=assertCurrent(handle);
      if (!run.binding.notifyEnabled) throw error('wake_notify_not_allowed');
      assertContactTime(run.binding.night,now(),store.control(run.scope).last_activity);
      store.beginSend(run.run_id,now(),digest(text));
      return {route:structuredClone(run.binding.route),key:'proactive:'+run.run_id,
        assertCurrent:()=>{
          const current=assertCurrent(handle,undefined,['sending']);
          assertContactTime(current.binding.night,now(),store.control(current.scope).last_activity);
        }};
    },
    complete(handle,status,reason) {return store.finish(handleRun(handle),status,reason);},
    recordReceipt(handle,value) {return store.receipt(handleRun(handle),value);},
    release(handle) {if (active.get(handle?.runId)===handle) active.delete(handle.runId);},
    activeCount:()=>active.size,
  };
}
