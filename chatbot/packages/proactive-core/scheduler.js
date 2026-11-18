import {error,time} from './policy.js';
// Wall-clock opportunities, no catch-up or startup send. Slot deduplication is
// durable in WakeStore; this scheduler never decides whether/how often to speak.
export function createWakeScheduler({intervalMs,wake,clock,onResult=()=>{}}) {
  if (!Number.isSafeInteger(intervalMs)||intervalMs<60000||intervalMs>86400000) throw error('invalid_wake_interval');
  if (typeof clock?.schedule !== 'function' || clock.version !== 1) throw error('wake_host_scheduler_required');
  let task,controller,busy=false,started=false;
  async function tick() {
    if (!started || clock.signal.aborted) return {status:'skipped',reason:'scheduler_stopped'};
    const at=time(clock.now());
    if (busy) return {status:'skipped',reason:'scheduler_busy'};
    busy=true;controller=new AbortController();
    const signal=AbortSignal.any([clock.signal,controller.signal]);
    try {const result=await wake({eventKey:'fixed:'+intervalMs+':'+Math.floor(at/intervalMs),signal});onResult(result);return result;}
    catch {const result={status:'failed',reason:'wake_scheduler_failed'};onResult(result);return result;}
    finally {busy=false;controller=undefined;}
  }
  function arm() {
    if (!started || clock.signal.aborted) return;
    const slot=Math.floor(time(clock.now())/intervalMs)+1;
    task=clock.schedule({id:'wake-slot',atMs:slot*intervalMs,async run(){
      try {if (Math.floor(time(clock.now())/intervalMs)===slot) await tick();}
      finally {arm();}
    }});
  }
  return {tick,start(){if(!started){started=true;arm();}},async stop(){started=false;controller?.abort();await task?.stop();task=undefined;},
    status:()=>({started,busy,intervalMs})};
}
