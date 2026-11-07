// Composition supplies the real host/model and a sender with a synchronous
// final-effect guard. No timers, concrete domain/plugin imports or production I/O.
import {decision,error} from './policy.js';
async function abortable(start,signal) {
  signal.throwIfAborted();let rejectAbort;
  const stopped=new Promise((_,reject)=>{rejectAbort=()=>reject(error('wake_aborted'));signal.addEventListener('abort',rejectAbort,{once:true});});
  try {return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return start();}),stopped]);}
  finally {signal.removeEventListener('abort',rejectAbort);}
}
export function createWakeService({authority,runModel,sendText}) {
  return {
    async wake({eventKey,timeoutMs=60000,signal}) {
      signal?.throwIfAborted();
      const claim=authority.begin({eventKey,timeoutMs});
      if (claim.skip) return {status:'skipped',reason:claim.skip};
      const {handle,run}=claim,controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      const scopeSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      let sending=false;
      try {
        const result=decision(await abortable(()=>runModel({runId:run.run_id,binding:structuredClone(run.binding),signal:scopeSignal}),scopeSignal));
        authority.assertCurrent(handle);
        if (result.kind==='silent') return {status:authority.complete(handle,'silent').status,runId:run.run_id};
        const delivery=authority.prepareDelivery(handle,result.text);sending=true;
        const receipt=await abortable(()=>sendText({...delivery,text:result.text,signal:scopeSignal,
          assertCurrent:()=>{scopeSignal.throwIfAborted();delivery.assertCurrent();}}),scopeSignal);
        return {status:authority.recordReceipt(handle,receipt).status,runId:run.run_id};
      } catch (e) {
        const status=sending?authority.recordReceipt(handle,{status:'unknown'}).status
          :authority.complete(handle,'failed',/^(wake_|untrusted_|invalid_|night_)[a-z_]+$/.test(e.code??'')?e.code:'wake_run_failed').status;
        return {status,runId:run.run_id,reason:/^(wake_|untrusted_|invalid_|night_)[a-z_]+$/.test(e.code??'')?e.code:'wake_run_failed'};
      } finally {clearTimeout(timer);controller.abort();authority.release(handle);}
    },
  };
}
