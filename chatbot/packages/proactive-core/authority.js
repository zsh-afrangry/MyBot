// Live, host-minted capability. Model-facing args never reach begin().
import {randomUUID} from 'node:crypto';
import {binding,fingerprint,error,digest,assertContactTime,time,decision} from './policy.js';

export function createWakeAuthority({store,authorize,now=Date.now}) {
  const active=new Map(),controllers=new Map();
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
      const controller=new AbortController(),handle=Object.freeze({runId,signal:controller.signal});
      active.set(runId,handle);controllers.set(runId,controller);
      return {handle,run:result.run};
    },
    // Host composition only: revokes authority, never grants it. Persist the fence
    // before aborting in-process work, so late/non-cooperative work stays fenced.
    invalidate(scope,change={}) {
      if (!/^qq:user:[0-9]{5,12}$/.test(scope??'')) throw error('invalid_wake_scope');
      const result=store.invalidate(scope,change);
      for (const [id,controller] of controllers) if (store.get(id)?.scope===scope) controller.abort();
      return result;
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
        // A factual receipt may arrive after cancellation/release. This narrow
        // closure cannot grant tools or initiate another send.
        recordReceipt:value=>store.receipt(run.run_id,value),
        assertCurrent:()=>{
          const current=assertCurrent(handle,undefined,['sending']);
          assertContactTime(current.binding.night,now(),store.control(current.scope).last_activity);
        }};
    },
    complete(handle,status,reason) {return store.finish(handleRun(handle),status,reason);},
    recordReceipt(handle,value) {return store.receipt(handleRun(handle),value);},
    release(handle) {if (active.get(handle?.runId)===handle) {active.delete(handle.runId);controllers.delete(handle.runId);}},
    activeCount:()=>active.size,
  };
}
